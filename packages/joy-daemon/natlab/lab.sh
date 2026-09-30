#!/usr/bin/env bash
# A two-NAT network in unprivileged namespaces, for testing hole punching for
# real. Run it under `unshare -rnm --propagation private`; nothing outside the
# new namespaces is touched and no root is needed.
#
#   hosta 10.1.0.2 ── nata ── 198.51.100.2 ┐
#   (daemon)          (NAT)                ├── this namespace: "the internet",
#   hostb 10.2.0.2 ── natb ── 203.0.113.2  ┘   where the relay (HTTP + STUN)
#   (client)          (NAT)                    has one address, 192.0.2.1
#
# The internet has no route to either 10.x network, so the two hosts can only
# reach each other through their NATs' public addresses: a direct path exists
# only if ICE punches it. NAT mode:
#   cone       masquerade, which keeps source ports where it can and admits
#              only replies to flows opened from inside (port-restricted cone,
#              like most home routers)
#   symmetric  masquerade with fully random ports per flow (like much
#              carrier-grade NAT): the address STUN reports is useless to
#              the peer, so punching must fail and traffic stays on the relay
#
# Usage: lab.sh <cone|symmetric> -- <command...>   (the command runs in the
# internet namespace; use `ip netns exec hosta …` / `hostb …` to reach in)
set -euo pipefail
mode=$1; shift
[ "${1:-}" = "--" ] && shift
case "$mode" in cone) masq="masquerade" ;; symmetric) masq="masquerade random,fully-random" ;; *) echo "lab.sh: unknown NAT mode $mode" >&2; exit 2 ;; esac

mount -t tmpfs none /run
mkdir -p /run/netns
ip link set lo up
# One address for the relay, as a real server has: a UDP reply must leave from
# the address the request was sent to, or the NAT rightly drops it.
ip addr add 192.0.2.1/32 dev lo
echo 1 > /proc/sys/net/ipv4/ip_forward

side() { # side <a|b> <public /24 prefix> <lan /24 prefix>
  local s=$1 pub=$2 lan=$3
  ip netns add "nat$s"; ip netns add "host$s"
  ip -n "nat$s" link set lo up; ip -n "host$s" link set lo up
  ip link add "up$s" type veth peer name "wan$s"
  ip link set "wan$s" netns "nat$s"
  ip addr add "$pub.1/24" dev "up$s"; ip link set "up$s" up
  ip -n "nat$s" addr add "$pub.2/24" dev "wan$s"; ip -n "nat$s" link set "wan$s" up
  ip -n "nat$s" link add "lan$s" type veth peer name "eth$s"
  ip -n "nat$s" link set "eth$s" netns "host$s"
  ip -n "nat$s" addr add "$lan.1/24" dev "lan$s"; ip -n "nat$s" link set "lan$s" up
  ip -n "host$s" addr add "$lan.2/24" dev "eth$s"; ip -n "host$s" link set "eth$s" up
  ip -n "nat$s" route add default via "$pub.1"
  ip -n "host$s" route add default via "$lan.1"
  ip netns exec "nat$s" sh -c 'echo 1 > /proc/sys/net/ipv4/ip_forward'
  # The router's firewall, as on any home router: nothing unsolicited from
  # the WAN, to the router or through it. It matters for punching: an early
  # probe that the router ACCEPTED into its own stack would leave a conntrack
  # entry that forces the host's own outgoing flow onto a different port.
  ip netns exec "nat$s" nft -f - <<NFT
table ip nat {
  chain post { type nat hook postrouting priority 100; oifname "wan$s" $masq; }
}
table inet fw {
  chain input { type filter hook input priority 0; iifname "wan$s" ct state new drop; }
  chain forward { type filter hook forward priority 0; iifname "wan$s" ct state new drop; }
}
NFT
}
side a 198.51.100 10.1.0
side b 203.0.113 10.2.0

exec "$@"

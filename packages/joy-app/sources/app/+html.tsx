import { ScrollViewStyleReset } from 'expo-router/html';
// Configures Unistyles (themes, breakpoints, CSS vars) for the static render.
// The module is Node-safe: its only browser hook (the visibilitychange theme
// re-sync) is guarded on `document` existing, because this file runs without
// a DOM.
import '../unistyles';

// This file is web-only and used to configure the root HTML for every
// web page during static rendering.
// The contents of this function only run in Node.js environments and
// do not have access to the DOM or browser APIs.
export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/*
          maximum-scale=1 prevents iOS Safari's automatic zoom-in when an
          input with font-size < 16px gains focus (e.g. the monospace
          terminal input). iOS deliberately ignores maximum-scale for user
          pinch gestures, so accessibility zoom keeps working — this only
          suppresses the focus auto-zoom.
        */}
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, shrink-to-fit=no" />

        {/* 
          Disable body scrolling on web. This makes ScrollView components work closer to how they do on native. 
          However, body scrolling is often nice to have for mobile web. If you want to enable it, remove this line.
        */}
        <ScrollViewStyleReset />

        {/* Using raw CSS styles as an escape-hatch to ensure the background color never flickers in dark-mode. */}
        <style dangerouslySetInnerHTML={{ __html: responsiveBackground }} />
        <style dangerouslySetInnerHTML={{ __html: buttonsAreNotText }} />
        {/* Add any additional <head> elements that you want globally available on web... */}
      </head>
      <body>{children}</body>
    </html>
  );
}

const responsiveBackground = `
body {
  background-color: #fff;
}
@media (prefers-color-scheme: dark) {
  body {
    background-color: #000;
  }
}`;

// A mouse dragging across a button — an option chip, Approve, the queue's
// Send, the send arrow itself — must press it, not paint its label blue.
// react-native-web renders every Pressable and Touchable as a <div> carrying a
// tabindex and nothing else that marks it, while message bodies are plain
// <div>/<span> trees with no tabindex and no button inside them, so this
// reaches the buttons and leaves the chat selectable. Only tabindex 0: a
// disabled button gets -1, and so would any view marked unfocusable, which
// could hold content. Form fields inside a button row (the queue's editable
// text) keep their own selection.
const buttonsAreNotText = `
[role="button"], [role="button"] *,
div[tabindex="0"], div[tabindex="0"] * {
  -webkit-user-select: none;
  user-select: none;
}
input, textarea, [contenteditable="true"] {
  -webkit-user-select: text;
  user-select: text;
}`;

// Copies teamstats/theme.css into index.html between the ts-theme markers, so
// the theme ships inside the page (the game's modals copy page <style>s into
// their shadow roots; a linked file would load too late for some of them).
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(__dirname, "theme.css"), "utf8");
const file = path.join(root, "index.html");
let html = fs.readFileSync(file, "utf8");
const block = `<!-- ts-theme:start -->\n    <style id="ts-theme">\n${css}\n    </style>\n    <!-- ts-theme:end -->`;
if (html.includes("<!-- ts-theme:start -->")) {
  html = html.replace(
    /<!-- ts-theme:start -->[\s\S]*?<!-- ts-theme:end -->/,
    block,
  );
} else {
  html = html.replace("  </head>", `    ${block}\n  </head>`);
}
fs.writeFileSync(file, html);

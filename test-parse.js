const fs = require("fs");
const code = fs.readFileSync(__dirname + "/out/extension.js", "utf8");
const m = code.match(/return \/\* html \*\/ `([\s\S]*?)`;/);
const html = m[1];
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const script = scriptMatch[1];

const lines = script.split("\n");
console.log("Script has", lines.length, "lines");

// Try to parse the full script
try {
  new Function(script);
  console.log("Full script parses OK");
} catch(e) {
  console.log("Full script parse error:", e.message);
}

// Try progressively larger chunks to find where it breaks
// Start from the end and work backwards, or use a binary approach
let lastGood = 0;
for (let i = 10; i <= lines.length; i += 10) {
  // Wrap in a try-catch to handle incomplete blocks
  const chunk = "(function() {\n" + lines.slice(0, i).join("\n") + "\n})();";
  try {
    // eslint-disable-next-line no-new-func
    new Function(chunk);
    lastGood = i;
  } catch(e) {
    // Failed - narrow down
    for (let j = lastGood + 1; j <= i; j++) {
      const subchunk = "(function() {\n" + lines.slice(0, j).join("\n") + "\n})();";
      try {
        new Function(subchunk);
        lastGood = j;
      } catch(e2) {
        console.log("\nFirst unparseable line:", j, ":", lines[j-1].substring(0, 120));
        console.log("Context (5 lines around):");
        for (let k = Math.max(0, j-3); k < Math.min(lines.length, j+2); k++) {
          const marker = k === j-1 ? ">>>" : "   ";
          console.log(marker, (k+1) + ":", lines[k].substring(0, 120));
        }
        // Don't break - show all issues
        break;
      }
    }
    // Continue scanning
  }
}

// Also dump the full HTML to inspect
fs.writeFileSync("/tmp/animus-webview.html", html);
console.log("\nFull HTML written to /tmp/animus-webview.html");
console.log("HTML lines:", html.split("\n").length);

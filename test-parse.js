const fs = require("fs");
const code = fs.readFileSync(__dirname + "/out/extension.js", "utf8");
const m = code.match(/return \/\* html \*\/ `([\s\S]*?)`;/);
const html = m[1];
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
const script = scriptMatch[1];

const lines = script.split("\n");
console.log("Script has", lines.length, "lines");

// Find lines with label-like syntax (word: at start of statement)
const suspect = [];
for (let i = 0; i < lines.length; i++) {
  const trimmed = lines[i].trim();
  // Skip case/default/labels in switch
  if (trimmed.startsWith("case ") || trimmed.startsWith("default:")) continue;
  // Skip property access (obj.prop:)
  // Skip ternary (cond ? :)
  // Look for bare word: at statement start
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/.test(trimmed)) {
    // Check it's not inside an object literal (line starts with { or ,)
    const prev = i > 0 ? lines[i-1].trim() : "";
    if (!prev.endsWith("{") && !prev.endsWith(",") && !trimmed.startsWith("{")) {
      suspect.push({ line: i+1, content: lines[i] });
    }
  }
}

console.log("\nLabel-like lines (potential SyntaxError sources):");
suspect.forEach(l => console.log("  L" + l.line + ":", l.content.substring(0, 120)));

// Also check for ${} sequences that survived compilation
const interp = script.match(/\$\{[^}]+\}/g);
if (interp) {
  console.log("\n${} sequences found in script:");
  interp.forEach(s => console.log("  ", s));
}

// Check for stray backticks
const backticks = (script.match(/`/g) || []).length;
console.log("\nBackticks in script:", backticks);

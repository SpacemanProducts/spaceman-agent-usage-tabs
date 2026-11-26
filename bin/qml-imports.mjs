// Static check for the plugin's QML files and their JS helpers. QML resolves a
// bare `Name.fn(...)` at runtime only, so a helper that was never imported (or
// imported under the component's own name) loads fine and then logs
// "TypeError: Property 'fn' of object X is not a function" on every binding
// (UsageChart.qml, 1.56.2). checkQml() finds that before the shell does:
//  - every `import "x.js" as Alias` names a file that exists, and Alias is not
//    the component's own name (inside Foo.qml, `Foo` is the component itself);
//  - every capitalized `X.fn(` call is a known global/singleton or an alias
//    imported in the same file;
//  - every `Alias.fn(` names a function that the helper file defines.
import fs from "node:fs";
import path from "node:path";

// JS globals, Qt/Quickshell, and the shell's singletons the plugin uses.
export const GLOBALS = new Set(["Math", "JSON", "Date", "Object", "Array", "String", "Number", "Boolean", "RegExp", "Promise",
  "Symbol", "Map", "Set", "Intl", "Qt", "Quickshell", "Style", "Commons"]);

// Code only: comments and string/template contents are blanked (a path like
// "qs://..." or a shell command in a string is not a call).
export function codeOnly(src) {
  let out = "", i = 0, q = "";
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      if (c === "\\") { out += "  "; i += 2; continue; }
      if (c === q) { q = ""; out += c; i++; continue; }
      out += c === "\n" ? "\n" : " "; i++; continue;
    }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") { out += " "; i++; } continue; }
    if (c === "/" && n === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, " "); i = end; continue; }
    if (c === '"' || c === "'" || c === "`") { q = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

// Names a helper file defines at top level: function f(, var/let/const f =.
export function jsExports(src) {
  const names = new Set();
  for (const m of codeOnly(src).matchAll(/^\s*(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=)/gm)) names.add(m[1] || m[2]);
  return names;
}

// Problems in one QML file's text, as strings. name: the component name (file
// basename). readJs(rel) returns a helper's source or null when it is missing.
export function checkQml(text, { name, readJs }) {
  const problems = [];
  const aliases = new Map();
  for (const m of text.matchAll(/^\s*import\s+"([^"]+\.js)"\s+as\s+([A-Za-z_$][\w$]*)/gm)) {
    const [, rel, alias] = m;
    if (alias === name) problems.push(`${name}.qml imports ${rel} as ${alias}, its own component name: calls on it reach the component, not the helper`);
    if (aliases.has(alias)) problems.push(`${name}.qml imports two files as ${alias}`);
    const src = readJs(rel);
    if (src === null) problems.push(`${name}.qml imports ${rel}, which does not exist`);
    aliases.set(alias, src === null ? null : jsExports(src));
  }
  const code = codeOnly(text);
  const seen = new Set();
  for (const m of code.matchAll(/(?<![\w$.])([A-Z][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [, obj, fn] = m;
    const key = obj + "." + fn;
    if (seen.has(key)) continue;
    seen.add(key);
    if (aliases.has(obj)) {
      const ex = aliases.get(obj);
      if (ex && !ex.has(fn)) problems.push(`${name}.qml calls ${key}(), but that helper defines no ${fn}`);
    } else if (!GLOBALS.has(obj)) {
      problems.push(`${name}.qml calls ${key}() with no \`import "….js" as ${obj}\`${obj === name ? " (inside this file that name is the component itself)" : ""}`);
    }
  }
  return problems;
}

// Every top-level .qml file of the plugin folder.
export function checkPlugin(dir) {
  const problems = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".qml")).sort()) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const readJs = (rel) => { try { return fs.readFileSync(path.resolve(dir, rel), "utf8"); } catch { return null; } };
    problems.push(...checkQml(text, { name: path.basename(f, ".qml"), readJs }));
  }
  return problems;
}

const fs = require("fs");
const m = JSON.parse(fs.readFileSync("dist/src/services/consolidationService.js.map", "utf8"));
console.log("sources:", m.sources);
console.log("sourcesContent lengths:", m.sourcesContent ? m.sourcesContent.map((s) => s && s.length) : "NONE");
if (m.sourcesContent && m.sourcesContent[0]) {
  fs.writeFileSync("recovered-consolidationService.ts", m.sourcesContent[0]);
  console.log("wrote recovered-consolidationService.ts");
}
const hash = "$2a$12$3BDc4a.AmJEmHM0LcArHmOUeRvP2/XID/YGCBEZCEf16M5tUHMc1a";

let bcrypt;
try {
  bcrypt = (await import("bcryptjs")).default;
} catch {
  bcrypt = (await import("bcrypt")).default;
}

const candidates = process.argv.slice(2);
if (candidates.length === 0) {
  console.log("Usage: node check-pw.js <password1> <password2> ...");
  process.exit(1);
}

for (const pw of candidates) {
  console.log(pw, "=>", await bcrypt.compare(pw, hash));
}
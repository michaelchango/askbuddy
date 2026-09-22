// Vercel Linux 环境诊断：验证构建时项目文件的真实可见性。
// 仅在 prebuild 里跑一次，输出 cwd / node 版本 / 关键文件存在性 / 目录列表 / resolve 测试。
// 定位「本地 build 成功、Vercel build 报 Module not found」的环境差异。定位后可删除。
const fs = require("node:fs");

console.log("[diag] cwd:", process.cwd());
console.log("[diag] node:", process.version);
console.log("[diag] platform:", process.platform);

const targets = [
  "lib/display.ts",
  "lib/utils.ts",
  "components/confirm-dialog.tsx",
  "components/project-new-form.tsx",
  "components/layout/dashboard-shell.tsx",
  "components/layout/page.tsx",
  "app/dashboard/page.tsx",
  "tsconfig.json",
];

for (const t of targets) {
  console.log(`[diag] ${fs.existsSync(t) ? "OK  " : "MISS"} ${t}`);
}

console.log("[diag] lib/ files:", fs.readdirSync("lib").join(", "));
console.log("[diag] components/ files:", fs.readdirSync("components").join(", "));

try {
  console.log(
    "[diag] require.resolve('./lib/display'):",
    require.resolve("./lib/display")
  );
} catch (e) {
  console.log("[diag] resolve FAILED:", e.code, "-", e.message.split("\n")[0]);
}

try {
  const tsconfig = JSON.parse(fs.readFileSync("tsconfig.json", "utf8"));
  console.log(
    "[diag] tsconfig paths:",
    JSON.stringify(tsconfig.compilerOptions?.paths)
  );
  console.log(
    "[diag] tsconfig baseUrl:",
    JSON.stringify(tsconfig.compilerOptions?.baseUrl)
  );
} catch (e) {
  console.log("[diag] tsconfig read FAILED:", e.message);
}

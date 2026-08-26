// esbuild 打包：产出 out/extension.js（扩展宿主）与 out/server.js（代理子进程）。
// 另把 Chart.js 的 UMD 产物复制到 out/chart.umd.js，供明细面板 webview 加载。
const esbuild = require("esbuild");
const { rmSync, copyFileSync } = require("fs");
const path = require("path");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: !production,
  minify: production,
  external: ["vscode"], // 扩展宿主运行时提供 vscode 模块；server 不 import vscode
  logLevel: "info",
};

async function main() {
  const outdir = path.join(__dirname, "out");
  rmSync(outdir, { recursive: true, force: true });

  const ctx = await esbuild.context({
    ...common,
    entryPoints: {
      extension: "src/extension.ts",
      server: "src/server/main.ts",
    },
    outdir,
  });

  if (watch) {
    await ctx.watch();
    console.log("[esbuild] watching…");
    console.log("[esbuild] build done (initial)");
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    console.log("[esbuild] build done → out/extension.js, out/server.js");
  }

  // 复制 Chart.js UMD（webview 需要独立脚本文件，不能打包进 extension.js）
  copyFileSync(
    path.join(__dirname, "node_modules", "chart.js", "dist", "chart.umd.js"),
    path.join(outdir, "chart.umd.js"),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

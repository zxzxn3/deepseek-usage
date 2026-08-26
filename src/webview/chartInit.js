// 明细面板图表初始化（webview 端静态脚本，由 build.js 复制到 out/chartInit.js）。
// 依赖全局：window.__CHART（扩展注入数据）、Chart（chart.umd.js）、vscode（页面内 acquireVsCodeApi）。
(function () {
  var d = window.__CHART;
  if (!d || typeof Chart === "undefined") return;
  var css = getComputedStyle(document.body);
  var col = function (v, f) { var s = css.getPropertyValue(v).trim(); return s || f; };
  var blue = col("--vscode-charts-blue", "#3794ff");
  var green = col("--vscode-charts-green", "#30a148");
  var purple = col("--vscode-charts-purple", "#b180d7");
  var orange = col("--vscode-charts-orange", "#ea5f00");
  var latColor = col("--vscode-charts-yellow", "#d7ba7d");
  var gridColor = col("--vscode-panel-border", "rgba(128,128,128,0.3)");
  var fmt = d.format === "cost"
    ? function (n) { return "￥" + (n || 0).toFixed(4); }
    : function (n) { n = n || 0; if (n < 1000) return String(n); if (n < 1000000) return (n / 1000).toFixed(1) + "k"; return (n / 1000000).toFixed(2) + "M"; };
  var alpha = function (hex, a) {
    if (hex[0] === "#" && hex.length === 7) {
      var r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
      return "rgba(" + r + "," + g + "," + b + "," + a + ")";
    }
    return hex;
  };
  var barA = 0.55;
  var datasets = [];
  datasets.push({ label: d.names.hit, data: d.hit, backgroundColor: alpha(blue, barA), stack: "u" });
  datasets.push({ label: d.names.miss, data: d.miss, backgroundColor: alpha(green, barA), stack: "u" });
  datasets.push({ label: d.names.out, data: d.out, backgroundColor: alpha(purple, barA), stack: "u" });
  if (d.latencyOn) {
    datasets.push({ label: d.names.latency, type: "line", data: d.latency, xAxisID: "x", yAxisID: "yLat", borderColor: latColor, backgroundColor: "transparent", pointRadius: 0, borderWidth: 1.5, spanGaps: true, tension: 0 });
  }
  var scales = {
    x: { stacked: true, grid: { color: function (ctx) { return d.showTick[ctx.index] ? gridColor : "transparent"; } }, ticks: { autoSkip: false, maxRotation: 0, font: { size: 9 }, callback: function (v, i) { return d.showTick[i] ? d.labels[i] : ""; } } },
    y: { stacked: true, beginAtZero: true, grid: { color: gridColor }, ticks: { font: { size: 9 }, callback: function (v) { return fmt(v); } } },
  };
  if (d.latencyOn) {
    var latVals = [];
    for (var i = 0; i < d.latency.length; i++) { if (d.latency[i] != null) latVals.push(d.latency[i]); }
    var latMin = latVals.length ? Math.min.apply(null, latVals) : 0;
    scales.yLat = { position: "right", stacked: false, min: latMin, grid: { drawOnChartArea: false }, ticks: { font: { size: 9 }, color: latColor, callback: function (v) { return v + "ms"; } } };
  }
  if (d.balance && d.balance.length) {
    datasets.push({ label: d.names.balance, type: "line", data: d.balance, xAxisID: d.useTimeAxis ? "xBal" : "x", yAxisID: "yBal", borderColor: orange, backgroundColor: "transparent", pointRadius: 0, borderWidth: 1.5, spanGaps: true, tension: 0 });
    if (d.useTimeAxis) {
      scales.xBal = { type: "linear", min: d.chartStart, max: d.chartEnd, offset: false, display: false, ticks: { display: false }, grid: { drawOnChartArea: false } };
    }
    scales.yBal = { position: "right", beginAtZero: true, stacked: false, grid: { drawOnChartArea: false }, ticks: { font: { size: 9 }, color: orange, callback: function (v) { return "￥" + (v || 0).toFixed(2); } } };
  }
  new Chart(document.getElementById("usageChart"), {
    type: "bar",
    data: { labels: d.labels, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: (function () {
        var st = vscode.getState() || {};
        if (!st.chartPainted) { st.chartPainted = true; vscode.setState(st); return { duration: 500 }; }
        return false;
      })(),
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: function (ctx) { if (ctx.dataset.yAxisID === "yBal") return ctx.dataset.label + ": ￥" + (ctx.parsed.y || 0).toFixed(2); if (ctx.dataset.yAxisID === "yLat") return ctx.dataset.label + ": " + (ctx.parsed.y || 0) + "ms"; return ctx.dataset.label + ": " + fmt(ctx.parsed.y); } } },
      },
      scales: scales,
    },
  });
})();

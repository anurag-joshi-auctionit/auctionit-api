import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import * as echarts from "echarts";
import type {
  MarketReportSeries,
  MarketReportTrendRow,
} from "../../services/market-report.service.js";

export const TREND_CHART_WIDTH = 1000;
export const TREND_CHART_HEIGHT = 400;

const FONT_FAMILY = "Times New Roman";
const TEXT_COLOR = "#000000";
const FONT_FILES = ["TimesNewRoman.ttf", "TimesNewRomanBold.ttf"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function resolveFontFiles(): string[] {
  const candidates = [
    join(dirname(fileURLToPath(import.meta.url)), "../../../public/fonts"),
    join(process.cwd(), "public/fonts"),
  ];
  for (const dir of candidates) {
    const files = FONT_FILES.map((f) => join(dir, f));
    if (files.every((f) => existsSync(f))) return files;
  }
  return [];
}

/** `YYYY-MM-DD` → `dd MMM` */
function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day} ${MONTHS[Number(month) - 1] ?? ""}`;
}

export function renderTrendChartSvg(
  series: MarketReportSeries[],
  rows: MarketReportTrendRow[],
): string {
  const chart = echarts.init(null, null, {
    renderer: "svg",
    ssr: true,
    width: TREND_CHART_WIDTH,
    height: TREND_CHART_HEIGHT,
  });
  try {
    chart.setOption({
      animation: false,
      backgroundColor: "#ffffff",
      textStyle: { fontFamily: FONT_FAMILY, color: TEXT_COLOR },
      legend: {
        top: 8,
        left: 70,
        type: "plain",
        textStyle: { fontSize: 12, color: TEXT_COLOR },
        data: series.map((s) => s.label),
      },
      grid: { left: 70, right: 24, top: 56, bottom: 64 },
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: rows.map((r) => shortDate(r.date)),
        axisLabel: {
          rotate: 90,
          fontSize: 10,
          interval: "auto",
          color: TEXT_COLOR,
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        axisLabel: {
          fontSize: 11,
          color: TEXT_COLOR,
          formatter: (v: number) => v.toLocaleString("en-IN"),
        },
        splitLine: { lineStyle: { color: "#e5e5e5" } },
      },
      series: series.map((s) => ({
        name: s.label,
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: rows.length <= 31 ? 4 : 0,
        showSymbol: rows.length <= 31,
        connectNulls: true,
        lineStyle: { width: 2 },
        data: rows.map((r) => r.prices[String(s.comboId)] ?? null),
      })),
    });
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

/** PNG rendered at 2x for print sharpness. */
export function renderTrendChartPng(
  series: MarketReportSeries[],
  rows: MarketReportTrendRow[],
): Buffer {
  const svg = renderTrendChartSvg(series, rows);
  const fontFiles = resolveFontFiles();
  const resvg = new Resvg(svg, {
    background: "#ffffff",
    fitTo: { mode: "width", value: TREND_CHART_WIDTH * 2 },
    font: {
      fontFiles,
      loadSystemFonts: fontFiles.length === 0,
      defaultFontFamily: FONT_FAMILY,
    },
  });
  return resvg.render().asPng();
}

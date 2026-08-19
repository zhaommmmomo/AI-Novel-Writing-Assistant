import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { createLogger, defineConfig, type Logger, type ProxyOptions } from "vite";

interface DesktopPackageJson {
  version?: unknown;
}

function clearStaleOptimizeCache(rootDir: string): void {
  const cacheDir = path.resolve(rootDir, "node_modules/.vite");
  const depsDir = path.join(cacheDir, "deps");
  const metadataPath = path.join(depsDir, "_metadata.json");
  if (!fs.existsSync(metadataPath)) {
    return;
  }

  try {
    const rawMetadata = fs.readFileSync(metadataPath, "utf8");
    const metadata = JSON.parse(rawMetadata) as {
      optimized?: Record<string, { src?: string }>;
    };
    const hasMissingSource = Object.values(metadata.optimized ?? {}).some((entry) => {
      if (!entry?.src) {
        return false;
      }
      const resolvedSource = path.resolve(depsDir, entry.src);
      return !fs.existsSync(resolvedSource);
    });
    if (!hasMissingSource) {
      return;
    }
  } catch {
    // Broken metadata should be treated the same as stale metadata.
  }

  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.info("[vite] Cleared stale optimize cache because cached dependency sources no longer exist.");
}

function resolveDevProxyTarget(): string {
  const configuredHost = process.env.HOST?.trim();
  const port = Number(process.env.PORT ?? 3000);
  const targetHost = configuredHost && !["0.0.0.0", "::"].includes(configuredHost)
    ? configuredHost
    : "127.0.0.1";
  return `http://${targetHost}:${port}`;
}

/**
 * The API needs well over a minute to boot while the client already polls `/api/health`
 * every second, so vite prints one ECONNREFUSED stack trace per request — dozens of them —
 * and buries everything else in the dev log. Collapse "the API is not listening yet" into a
 * single line per outage; every other proxy error is still reported in full.
 *
 * Vite registers its own proxy error handler after `configure` runs, so the muting has to
 * happen in the logger rather than on the proxy itself.
 */
const apiProxyOutage: { offlineSince: number | null } = { offlineSince: null };

const configureApiProxy: NonNullable<ProxyOptions["configure"]> = (proxy) => {
  proxy.on("proxyRes", () => {
    if (apiProxyOutage.offlineSince === null) {
      return;
    }
    const seconds = Math.round((Date.now() - apiProxyOutage.offlineSince) / 1000);
    apiProxyOutage.offlineSince = null;
    console.info(`[vite] API is reachable again after ${seconds}s.`);
  });
};

function createDevLogger(): Logger {
  const logger = createLogger();
  const logError = logger.error.bind(logger);
  logger.error = (message, options) => {
    const code = (options?.error as NodeJS.ErrnoException | undefined)?.code;
    const isApiBooting = message.includes("http proxy error")
      && (code === "ECONNREFUSED" || code === "ECONNRESET");
    if (!isApiBooting) {
      logError(message, options);
      return;
    }
    if (apiProxyOutage.offlineSince !== null) {
      return;
    }
    apiProxyOutage.offlineSince = Date.now();
    logger.warn(
      `API at ${resolveDevProxyTarget()} is not reachable yet; further proxy errors are muted until it answers.`,
      { timestamp: true },
    );
  };
  return logger;
}

function resolveDesktopAppVersion(): string {
  const desktopPackagePath = path.resolve(__dirname, "../desktop/package.json");
  const packageJson = JSON.parse(fs.readFileSync(desktopPackagePath, "utf8")) as DesktopPackageJson;
  const version = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`desktop/package.json version must be stable semver like 0.3.19, got ${version || "(empty)"}.`);
  }
  return version;
}

clearStaleOptimizeCache(__dirname);

const isDesktopRelativeBaseBuild = process.env.AI_NOVEL_CLIENT_BASE === "relative";
const appVersion = resolveDesktopAppVersion();

export default defineConfig({
  base: isDesktopRelativeBaseBuild ? "./" : "/",
  customLogger: createDevLogger(),
  plugins: [react()],
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "@ai-novel/shared": path.resolve(__dirname, "../shared"),
    },
  },
  build: {
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) {
            return undefined;
          }
          if (id.includes("@assistant-ui") || id.includes("@langchain/langgraph-sdk")) {
            return "assistant-ui";
          }
          if (id.includes("platejs") || id.includes("@platejs")) {
            return "plate-editor";
          }
          return "vendor";
        },
      },
    },
  },
  server: {
    host: true,
    proxy: {
      "/api": {
        target: resolveDevProxyTarget(),
        changeOrigin: true,
        configure: configureApiProxy,
      },
    },
  },
});

import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.pharos.app",
  appName: "Pharos",
  webDir: "dist",
  // Forward JS console.log/info/warn/error to the native logger so they
  // appear in Xcode's debug console (and Android logcat). Also gives us
  // Safari Web Inspector access on iOS for richer object inspection.
  // Default in Capacitor 7 is already "debug"; setting it explicitly
  // documents intent and survives any future default change.
  loggingBehavior: "debug",
  server: {
    androidScheme: "https",
  },
  plugins: {
    Geolocation: {
      permissions: ["location"],
    },
    // Route window.fetch and XMLHttpRequest through native URLSession
    // instead of WKWebView's network stack. WKWebView fetch from a
    // `capacitor://localhost` origin fails opaquely ("Load failed") on
    // large external POSTs (e.g. Overpass) and on some TLS configs;
    // native URLSession sidesteps both. The patch is transparent to
    // calling code -- existing fetch calls work unchanged.
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;

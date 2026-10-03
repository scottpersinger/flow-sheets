import { defineRailway, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const web = service("web", {
    build: "npm run build",
    start: "npm start",
    healthcheck: "/api/health",
    healthcheckTimeout: 60,
    // Restarts on failure (Railway's default policy), up to 5 times.
    deploy: {
      restartPolicyMaxRetries: 5,
    },
    env: {
      // SQLite database and per-sheet JSON files live on the volume.
      DATA_DIR: "/data",
      // Railway serves over HTTPS, so session cookies can be Secure.
      SECURE_COOKIES: "1",
      // Self-improvement: app-change jobs run Claude Code in this container, so the image needs git and the
      // dev dependencies (vite, vitest, tsc) to rebuild and verify. GITHUB_TOKEN (contents + pull requests,
      // read/write) is set in the dashboard, not here.
      RAILPACK_DEPLOY_APT_PACKAGES: "git",
      RAILPACK_PRUNE_DEPS: "false",
      // Give in-flight requests a moment to finish when a deploy replaces the container.
      RAILWAY_DEPLOYMENT_DRAINING_SECONDS: "15",
    },
    volumeMounts: {
      "/data": volume("flow-sheets-data", { region: "sfo", sizeMB: 5000 }),
    },
    domains: ["sheets.freeflow.im"],
    // A volume can only be attached to a single replica.
    replicas: { sfo: 1 },
  });

  return project("flow-sheets", {
    resources: [web],
  });
});

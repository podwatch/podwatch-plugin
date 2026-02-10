import { describe, it, expect } from "vitest";
import { classifyTool } from "./classifier.js";

describe("classifier", () => {
  describe("accessesCredentials", () => {
    it("detects read on .env file", () => {
      const result = classifyTool("read", { path: "/app/.env" });
      expect(result.accessesCredentials).toBe(true);
    });

    it("detects read_file on .env.local", () => {
      const result = classifyTool("read_file", { file_path: "/app/.env.local" });
      expect(result.accessesCredentials).toBe(true);
    });

    it("detects read on .key file", () => {
      const result = classifyTool("read", { path: "/certs/server.key" });
      expect(result.accessesCredentials).toBe(true);
    });

    it("detects read on .pem file", () => {
      const result = classifyTool("read", { path: "/certs/ca.pem" });
      expect(result.accessesCredentials).toBe(true);
    });

    it("detects read on .ssh/ path", () => {
      const result = classifyTool("read", { path: "/home/user/.ssh/id_rsa" });
      expect(result.accessesCredentials).toBe(true);
    });

    it("detects read on id_ed25519", () => {
      const result = classifyTool("read", { path: "/home/user/.ssh/id_ed25519" });
      expect(result.accessesCredentials).toBe(true);
    });

    it("detects read on .aws/credentials", () => {
      const result = classifyTool("read", { path: "/home/user/.aws/credentials" });
      expect(result.accessesCredentials).toBe(true);
    });

    it("does NOT flag read on normal files", () => {
      const result = classifyTool("read", { path: "/app/src/index.ts" });
      expect(result.accessesCredentials).toBe(false);
    });

    it("does NOT flag non-read tools", () => {
      const result = classifyTool("write", { path: "/app/.env" });
      expect(result.accessesCredentials).toBe(false);
    });

    it("handles missing path params", () => {
      const result = classifyTool("read", {});
      expect(result.accessesCredentials).toBe(false);
    });
  });

  describe("makesNetworkCall", () => {
    it("detects web_fetch", () => {
      expect(classifyTool("web_fetch", {}).makesNetworkCall).toBe(true);
    });

    it("detects curl", () => {
      expect(classifyTool("curl", {}).makesNetworkCall).toBe(true);
    });

    it("detects wget", () => {
      expect(classifyTool("wget", {}).makesNetworkCall).toBe(true);
    });

    it("detects http_request", () => {
      expect(classifyTool("http_request", {}).makesNetworkCall).toBe(true);
    });

    it("does NOT flag read", () => {
      expect(classifyTool("read", {}).makesNetworkCall).toBe(false);
    });
  });

  describe("persistenceAttempt", () => {
    it("detects crontab via exec", () => {
      const result = classifyTool("exec", { command: "crontab -e" });
      expect(result.persistenceAttempt).toBe(true);
    });

    it("detects systemctl via bash", () => {
      const result = classifyTool("bash", { command: "systemctl enable myservice" });
      expect(result.persistenceAttempt).toBe(true);
    });

    it("detects systemd via spawn", () => {
      const result = classifyTool("spawn", { command: "cp myservice.service /etc/systemd/system/" });
      expect(result.persistenceAttempt).toBe(true);
    });

    it("detects autostart in command", () => {
      const result = classifyTool("exec", { command: "cp app.desktop ~/.config/autostart/" });
      expect(result.persistenceAttempt).toBe(true);
    });

    it("detects launchctl via exec", () => {
      const result = classifyTool("exec", { command: "launchctl load ~/Library/LaunchAgents/com.app.plist" });
      expect(result.persistenceAttempt).toBe(true);
    });

    it("detects rc.local modification", () => {
      const result = classifyTool("bash", { command: "echo '/usr/bin/myapp' >> /etc/rc.local" });
      expect(result.persistenceAttempt).toBe(true);
    });

    it("does NOT flag normal exec commands", () => {
      const result = classifyTool("exec", { command: "ls -la" });
      expect(result.persistenceAttempt).toBe(false);
    });

    it("does NOT flag non-exec tools", () => {
      const result = classifyTool("read", { command: "crontab -l" });
      expect(result.persistenceAttempt).toBe(false);
    });

    it("handles missing command param", () => {
      const result = classifyTool("exec", {});
      expect(result.persistenceAttempt).toBe(false);
    });
  });

  describe("combined classification", () => {
    it("returns all false for benign tool call", () => {
      const result = classifyTool("read", { path: "/app/README.md" });
      expect(result.accessesCredentials).toBe(false);
      expect(result.makesNetworkCall).toBe(false);
      expect(result.persistenceAttempt).toBe(false);
    });

    it("only flags relevant properties", () => {
      const result = classifyTool("web_fetch", { url: "https://example.com" });
      expect(result.accessesCredentials).toBe(false);
      expect(result.makesNetworkCall).toBe(true);
      expect(result.persistenceAttempt).toBe(false);
    });
  });
});

import { Container } from "@cloudflare/containers";

export class SandboxContainer extends Container {
  defaultPort = 3000;
  sleepAfter = 1800; // 30 minutes
  enableInternet = true;
}

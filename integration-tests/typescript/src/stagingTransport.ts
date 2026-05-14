import { FetchTransport } from "reasoning-ledger-sdk";
import type { HttpRequest, HttpResponse, HttpTransport } from "reasoning-ledger-sdk";

// The staging URL the user deployed to. ENDPOINTS.staging in the SDK points at
// a different hostname, and registerAgent/resolveAgentId are hard-coded to
// ENDPOINTS.production (SDK v0.1.0), so we rewrite any stairai.com host to the
// staging host before dispatching. This keeps test code using the normal SDK
// surface without republishing the SDKs.
const PROD_HOSTS = ["https://api.stairai.com", "https://staging.api.stairai.com"];

function rewriteUrl(url: string, stagingBase: string): string {
  for (const host of PROD_HOSTS) {
    if (url.startsWith(host)) {
      return stagingBase + url.slice(host.length);
    }
  }
  return url;
}

export class StagingTransport implements HttpTransport {
  private readonly inner: HttpTransport;
  private readonly stagingBase: string;

  constructor(stagingBase: string, inner: HttpTransport = new FetchTransport()) {
    this.stagingBase = stagingBase.replace(/\/$/, "");
    this.inner = inner;
  }

  request(req: HttpRequest): Promise<HttpResponse> {
    return this.inner.request({ ...req, url: rewriteUrl(req.url, this.stagingBase) });
  }
}

import { env } from "../env.js";

// Thin client for the Instamojo v2 (OAuth2 client_credentials) Gateway Orders
// API. Ports the legacy InstamojoAPI.dll flow: obtain a bearer token, create an
// order, and confirm success by polling the order status by our merchant
// transaction id. NOTE: the v2 REST sub-paths (`gateway/orders/…`) follow
// Instamojo's documented Payment-Gateway API and may need adjusting to your
// account's exact endpoints.

export class InstamojoError extends Error {
  constructor(
    message: string,
    public status?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "InstamojoError";
  }
}

export class InstamojoDisabledError extends Error {
  constructor() {
    super("Instamojo payments are not enabled");
    this.name = "InstamojoDisabledError";
  }
}

export type CreateOrderInput = {
  name: string;
  email: string;
  phone?: string | null;
  amount: number;
  transactionId: string;
  redirectUrl: string;
};

export type CreatedOrder = {
  orderId: string | null;
  paymentUrl: string;
};

export type InstamojoOrderStatus = {
  // Order-level status; "completed" means paid & settled.
  status: string;
  amount: number | null;
  // Individual payment attempts; the successful one carries the MOJO… id.
  payments: { id: string; status: string; failure: string | null }[];
};

let cachedToken: { value: string; expiresAt: number } | null = null;

export class InstamojoService {
  isEnabled(): boolean {
    return (
      env.INSTAMOJO_ENABLED &&
      !!env.INSTAMOJO_CLIENT_ID &&
      !!env.INSTAMOJO_CLIENT_SECRET
    );
  }

  private assertEnabled(): void {
    if (!this.isEnabled()) throw new InstamojoDisabledError();
  }

  private async getAccessToken(): Promise<string> {
    // Reuse the cached token until ~60s before it expires.
    if (cachedToken && cachedToken.expiresAt - 60_000 > Date.now()) {
      return cachedToken.value;
    }
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.INSTAMOJO_CLIENT_ID!,
      client_secret: env.INSTAMOJO_CLIENT_SECRET!,
    });
    const res = await fetch(env.INSTAMOJO_AUTH_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json().catch(() => null)) as {
      access_token?: string;
      expires_in?: number;
    } | null;
    if (!res.ok || !json?.access_token) {
      throw new InstamojoError("Failed to obtain Instamojo token", res.status, json);
    }
    const ttlMs = (json.expires_in ?? 3600) * 1000;
    cachedToken = { value: json.access_token, expiresAt: Date.now() + ttlMs };
    return json.access_token;
  }

  private apiUrl(path: string): string {
    // env.INSTAMOJO_API_URL is expected to end with a slash (".../v2/").
    return `${env.INSTAMOJO_API_URL}${path}`;
  }

  async createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    this.assertEnabled();
    const token = await this.getAccessToken();
    const res = await fetch(this.apiUrl("gateway/orders/"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: input.name,
        email: input.email,
        phone: input.phone || undefined,
        amount: input.amount.toFixed(2),
        currency: "INR",
        transaction_id: input.transactionId,
        redirect_url: input.redirectUrl,
      }),
    });
    const json = (await res.json().catch(() => null)) as {
      order?: { id?: string };
      payment_options?: { payment_url?: string };
    } | null;
    const paymentUrl = json?.payment_options?.payment_url;
    if (!res.ok || !paymentUrl) {
      throw new InstamojoError("Failed to create Instamojo order", res.status, json);
    }
    return { orderId: json?.order?.id ?? null, paymentUrl };
  }

  async getOrderByTransactionId(
    transactionId: string,
  ): Promise<InstamojoOrderStatus | null> {
    this.assertEnabled();
    const token = await this.getAccessToken();
    const res = await fetch(
      this.apiUrl(`gateway/orders/transaction_id:${encodeURIComponent(transactionId)}/`),
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return null;
    const json = (await res.json().catch(() => null)) as {
      status?: string;
      amount?: number | string;
      payments?: { id?: string; status?: string; failure?: string | null }[];
    } | null;
    if (!res.ok || !json) {
      throw new InstamojoError("Failed to fetch Instamojo order", res.status, json);
    }
    return {
      status: String(json.status ?? "").toLowerCase(),
      amount: json.amount != null ? Number(json.amount) : null,
      payments: (json.payments ?? []).map((p) => ({
        id: String(p.id ?? ""),
        status: String(p.status ?? "").toLowerCase(),
        failure: p.failure ?? null,
      })),
    };
  }
}

export const instamojoService = new InstamojoService();

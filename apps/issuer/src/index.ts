import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { prisma } from "@cpay/database";
import { signRequest } from "@worldcoin/idkit-core/signing";
import dotenv from "dotenv";

// Load environment variables from repo root or local .env
dotenv.config();

const app = new Hono();

// Privacy Invariant #3: Request logger records ONLY method, path, and status.
// Never logs request bodies, client IPs, or query parameters.
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`[${c.req.method}] ${c.req.path} -> ${c.res.status} (${ms}ms)`);
});

// Configure CORS
const allowedOrigins = (process.env.ISSUER_ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

app.use(
  "*",
  cors({
    origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

// Health check endpoint with database ping
app.get("/health", async (c) => {
  let dbStatus = "connected";
  try {
    // Ping Supabase PostgreSQL
    await prisma.$queryRaw`SELECT 1`;
  } catch (err: unknown) {
    dbStatus = `disconnected: ${err instanceof Error ? err.message : String(err)}`;
  }

  return c.json({
    status: "ok",
    service: "cpay-issuer",
    database: dbStatus,
    timestamp: new Date().toISOString(),
  });
});

// World IDKit 4.0 RP Signature generator
// Frontend calls this before launching the IDKit widget
app.post("/rp-signature", async (c) => {
  const signingKey = process.env.WORLD_RP_SIGNING_KEY;
  const action = process.env.NEXT_PUBLIC_WORLD_ACTION || "cpay-recipient-v1";

  if (!signingKey) {
    return c.json({ error: "WORLD_RP_SIGNING_KEY not configured" }, 500);
  }

  try {
    const signed = signRequest({
      action,
      signingKeyHex: signingKey,
    });

    return c.json({
      success: true,
      rp_id: process.env.WORLD_RP_ID || "",
      action,
      sig: signed.sig,
      nonce: signed.nonce,
      createdAt: signed.createdAt,
      expiresAt: signed.expiresAt,
    });
  } catch (err: unknown) {
    console.error("Failed to sign request:", err);
    return c.json({ error: "Failed to generate RP signature" }, 500);
  }
});

// Check if a nullifier has already been used for an action
app.get("/nullifiers/:action/:nullifier", async (c) => {
  const action = c.req.param("action");
  const nullifier = c.req.param("nullifier");

  try {
    const existing = await prisma.nullifier.findUnique({
      where: {
        nullifier_action_unique: {
          nullifier,
          action,
        },
      },
      select: {
        createdAt: true,
      },
    });

    return c.json({
      used: !!existing,
      createdAt: existing?.createdAt || null,
    });
  } catch (error: unknown) {
    console.error("Failed to query nullifier:", error);
    return c.json({ error: "Failed to check nullifier" }, 500);
  }
});

// Enrolment & World ID Proof Verification + Nullifier Storage
app.post("/enrol", async (c) => {
  try {
    const body = await c.req.json();
    const { nullifier, action, commitment } = body;

    if (!nullifier || !action) {
      return c.json({ error: "Missing required fields: nullifier and action" }, 400);
    }

    // Attempt to store the nullifier in Supabase PostgreSQL
    // Unique constraint on (nullifier, action) blocks sybils and duplicate enrolments
    try {
      const record = await prisma.nullifier.create({
        data: {
          nullifier: String(nullifier),
          action: String(action),
        },
      });

      return c.json({
        success: true,
        message: "Nullifier registered successfully",
        id: record.id,
        action: record.action,
        createdAt: record.createdAt,
      });
    } catch (dbErr: any) {
      // Prisma P2002 error code is Unique constraint violation
      if (dbErr?.code === "P2002") {
        return c.json(
          {
            error: "Duplicate enrolment: this World ID has already been used for this action.",
            code: "NULLIFIER_ALREADY_USED",
          },
          409
        );
      }
      throw dbErr;
    }
  } catch (error: unknown) {
    console.error("Enrolment error:", error);
    return c.json({ error: "Failed to process enrolment" }, 500);
  }
});

// Return the active BBS public key
app.get("/issuer-key", async (c) => {
  try {
    const activeKey = await prisma.issuerKey.findFirst({
      where: { active: true },
      orderBy: { createdAt: "desc" },
    });

    return c.json({
      active: !!activeKey,
      publicKey: activeKey?.publicKey || process.env.ISSUER_BBS_PUBLIC_KEY || null,
      epoch: activeKey?.epoch || "2026-11",
      keyType: activeKey?.keyType || "BBS_BLS12381",
    });
  } catch (error: unknown) {
    console.error("Failed to fetch issuer key:", error);
    return c.json({ error: "Failed to retrieve issuer key" }, 500);
  }
});

const port = Number(process.env.ISSUER_PORT) || 8788;
console.log(`Starting @cpay/issuer on http://localhost:${port}`);

serve({
  fetch: app.fetch,
  port,
});

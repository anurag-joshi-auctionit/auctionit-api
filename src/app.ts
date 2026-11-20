import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import { env } from "./env.js";
import authRouter from "./routes/auth.js";
import biddersRouter from "./routes/bidders.js";
import clientsRouter from "./routes/clients.js";
import itemsRouter from "./routes/items.js";
import serviceInvoicesRouter from "./routes/service-invoices.js";
import benchmarkMaterialLocationsRouter from "./routes/benchmark-material-locations.js";
import benchmarkPricesRouter from "./routes/benchmark-prices.js";
import locationsRouter from "./routes/locations.js";

export function createApp() {
  const app = express();

  if (env.NODE_ENV === "development" || env.NODE_ENV === "local") {
    app.use(cors({ origin: "*" }));
  }
  app.use(express.json({ limit: Infinity }));
  app.use(cookieParser());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/auth", authRouter);
  app.use("/locations", locationsRouter);
  app.use("/clients", clientsRouter);
  app.use("/bidders", biddersRouter);
  app.use("/items", itemsRouter);
  app.use("/service-invoices", serviceInvoicesRouter);
  app.use("/benchmark-material-locations", benchmarkMaterialLocationsRouter);
  app.use("/benchmark-prices", benchmarkPricesRouter);

  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      console.error(err);
      res.status(500).json({ error: "Internal server error" });
    },
  );

  return app;
}

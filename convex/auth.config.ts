import type { AuthConfig } from "convex/server";

// Convex verifies the Clerk-issued JWT (template / integration named "convex").
// CLERK_JWT_ISSUER_DOMAIN is set in the Convex deployment's environment, e.g.
//   npx convex env set CLERK_JWT_ISSUER_DOMAIN https://your-app.clerk.accounts.dev
export default {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN!,
      applicationID: "convex",
    },
  ],
} satisfies AuthConfig;

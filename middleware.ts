import { clerkMiddleware } from "@clerk/nextjs/server";

// Clerk reads the session on every request. Access decisions are NOT made here
// by matching paths: the (app) layout calls auth.protect(), and every Convex
// function checks the caller itself (convex/lib/auth.ts).
export default clerkMiddleware();

export const config = {
  matcher: [
    // Skip Next.js internals and static files, unless found in search params
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};

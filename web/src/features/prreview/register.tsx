/**
 * PR review: the page `#/pr/<agent>` on desktop and phone (Summary, Files
 * with review threads, Checks). The PR card's "Review" opens it. Metadata
 * and lazy chunks only (this file loads at start).
 */
import { lazy } from "../../lib/lazy.tsx";
import { type PageProps, registerPage } from "../../lib/registry.tsx";

const ReviewDesktop = lazy<PageProps>(() => import("./ReviewDesktop.tsx"));
const ReviewPhone = lazy<PageProps>(() => import("./ReviewPhone.tsx"));

registerPage({ name: "pr", desktop: ReviewDesktop, phone: ReviewPhone });

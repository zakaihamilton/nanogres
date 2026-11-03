import { notFound } from "next/navigation";
import PreviewClient from "./preview-client";

export const metadata = {
  title: "UI preview · Nanogres",
};

export default function UiPreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <PreviewClient />;
}

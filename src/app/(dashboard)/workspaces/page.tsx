import { redirect } from "next/navigation";

export default function LegacyWorkspacesPage(): never {
  redirect("/organizations");
}

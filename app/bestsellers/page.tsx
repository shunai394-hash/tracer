import { redirect } from "next/navigation";

export default function BestsellersPage() {
  // Marketplace rankings are research signals, not products TRACER can sell.
  redirect("/shop");
}

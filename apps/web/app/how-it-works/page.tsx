import { redirect } from "next/navigation";

// The flow now lives on the home page's second screen. This route stays so
// links already in the wild keep working, and sends them there.
export default function HowItWorksPage() {
  redirect("/#flow");
}

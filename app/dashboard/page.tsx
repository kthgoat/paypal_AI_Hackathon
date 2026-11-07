import type { Metadata } from "next";
import Dashboard from "@/components/studio/dashboard";
import "./dashboard.css";

export const metadata: Metadata = { title: "Dashboard | BountyPilot" };

export default function DashboardPage() {
  return <Dashboard />;
}

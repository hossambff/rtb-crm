"use client";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton({ label = "Print / Save as PDF", variant = "secondary" }: { label?: string; variant?: "primary" | "secondary" }) {
  return (
    <Button variant={variant} onClick={() => window.print()}>
      <Printer /> {label}
    </Button>
  );
}

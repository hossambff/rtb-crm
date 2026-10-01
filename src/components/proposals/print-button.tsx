"use client";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

export function PrintButton() {
  return (
    <Button variant="primary" onClick={() => window.print()}>
      <Printer /> Print / Save as PDF
    </Button>
  );
}

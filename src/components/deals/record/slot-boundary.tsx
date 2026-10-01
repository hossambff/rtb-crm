"use client";
import * as React from "react";

/**
 * QA MIN-20: an error thrown anywhere inside a deal-page slot (including nested async server components that stream in
 * later) renders nothing instead of taking the whole deal page down to the route error boundary.
 */
export class SlotBoundary extends React.Component<{ name: string; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[deal-slot] ${this.props.name} failed`, error instanceof Error ? error.message : "");
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

import type { Metadata } from "next";
import { Playfair_Display, Work_Sans } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

const workSans = Work_Sans({ variable: "--font-work-sans", subsets: ["latin"], weight: ["300", "400", "500", "600"] });
const playfair = Playfair_Display({ variable: "--font-playfair", subsets: ["latin"], weight: ["400", "500", "600"], style: ["normal", "italic"] });

export const metadata: Metadata = {
  title: { default: "Roundtable Sales OS", template: "%s · Roundtable" },
  description: "RTB's AI-native sales operating system.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${workSans.variable} ${playfair.variable} h-full`}>
      <body className="min-h-full bg-bg text-body">
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{ style: { background: "#1a1a1a", border: "1px solid #3c3c3c", color: "#f4f4f4" } }}
        />
      </body>
    </html>
  );
}

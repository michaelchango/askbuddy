"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function TokenSettingsRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/dashboard/tokens");
  }, [router]);
  return null;
}

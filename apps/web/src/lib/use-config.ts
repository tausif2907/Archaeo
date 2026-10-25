"use client";

import { useEffect, useState } from "react";
import type { AppConfigDto } from "@archaeo/shared";
import { api } from "./api";

let cached: Promise<AppConfigDto | null> | null = null;

/** The API's /config, fetched once per page load. Null until it arrives, or when the API is unreachable. */
export function useAppConfig(): AppConfigDto | null {
  const [config, setConfig] = useState<AppConfigDto | null>(null);
  useEffect(() => {
    cached ??= api.config().catch(() => null);
    let live = true;
    void cached.then((c) => {
      if (live) setConfig(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return config;
}

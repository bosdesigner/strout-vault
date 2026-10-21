import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError, onUnauthenticated, setCsrfToken } from "@/lib/api";

export interface Me {
  user: { email: string; role: string };
  csrfToken: string;
}

export function useMe() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        const me = await api<Me>("/auth/me");
        setCsrfToken(me.csrfToken);
        return me;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          setCsrfToken(null);
          return null;
        }
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  useEffect(() => {
    const off = onUnauthenticated(() => {
      setCsrfToken(null);
      qc.setQueryData(["me"], null);
    });
    return () => {
      off();
    };
  }, [qc]);
  return query;
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => api<Me>("/auth/login", { method: "POST", json: input }),
    onSuccess: (me) => {
      setCsrfToken(me.csrfToken);
      qc.setQueryData(["me"], me);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSettled: () => {
      setCsrfToken(null);
      qc.clear();
      qc.setQueryData(["me"], null);
    },
  });
}

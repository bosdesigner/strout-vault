import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { Lock, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useLogin, useMe, useRequestMagicLink } from "@/hooks/useAuth";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

export default function LoginPage() {
  const me = useMe();
  const login = useLogin();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from || "/";
  const [params] = useSearchParams();
  const [mode, setMode] = useState<"password" | "link">(params.get("mode") === "link" ? "link" : "password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const magic = useRequestMagicLink();
  const linkError = params.get("error") === "link";

  useEffect(() => {
    document.title = "Sign in · Strout Vault";
  }, []);

  if (me.data) return <Navigate to={from} replace />;

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (mode === "link") magic.mutate({ email });
    else login.mutate({ email, password }, { onSuccess: () => navigate(from, { replace: true }) });
  };
  const err = login.error instanceof ApiError ? login.error : null;
  const magicErr = magic.error instanceof ApiError ? magic.error : null;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center">
            <Lock className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight">Strout Vault</h1>
            <p className="text-sm text-muted-foreground">Every recorded conversation, in one place.</p>
          </div>
        </div>
        <div className="mb-4 inline-flex rounded-lg bg-muted p-1 text-sm" role="tablist" aria-label="Sign-in method">
          {(["password", "link"] as const).map((m) => (
            <button key={m} role="tab" aria-selected={mode === m} type="button" onClick={() => setMode(m)} className={cn("rounded-md px-3 py-1", mode === m && "bg-background shadow-sm")} data-testid={`mode-${m}`}>
              {m === "password" ? "Password" : "Email me a link"}
            </button>
          ))}
        </div>
        {linkError && !magic.isSuccess && (
          <p role="alert" className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            That sign-in link has expired or was already used. Request a new one.
          </p>
        )}
        {magic.isSuccess ? (
          <div className="rounded-lg border p-4" data-testid="link-sent">
            <MailCheck className="h-5 w-5 text-primary" />
            <p className="mt-2 text-sm font-medium">Check your email</p>
            <p className="mt-1 text-sm text-muted-foreground">If {email} has access, a sign-in link is on its way. It works once and expires in about 20 minutes.</p>
            <Button variant="link" className="mt-2 h-auto p-0" onClick={() => magic.reset()}>Use a different address</Button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
            </div>
            {mode === "password" && (
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input id="password" name="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            )}
            {mode === "link" && <p className="text-sm text-muted-foreground">Contractors sign in with a link sent to the email address Ben set up for them.</p>}
            {(err || magicErr) && (
              <p role="alert" className="text-sm text-destructive">
                {(err ?? magicErr)!.status === 429 ? "Too many attempts. Wait a few minutes and try again." : (err ?? magicErr)!.message}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={mode === "password" ? login.isPending || !email || !password : magic.isPending || !email} data-testid="submit-login">
              {mode === "password" ? (login.isPending ? "Signing in…" : "Sign in") : magic.isPending ? "Sending…" : "Email me a sign-in link"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

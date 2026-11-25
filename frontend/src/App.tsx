
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  useNavigate,
  useLocation,
} from "react-router-dom";

import {
  loginUser,
  registerUser,
  scheduleBulkEmailsAPI,
  getScheduledEmails,
  getSentEmails,
  deleteScheduledEmailAPI,
  deleteSentEmailAPI,
  getGmailStatus,
  startGmailConnect,
  disconnectGmail,
} from "./services/api";

import "./App.css";

type Page = "scheduled" | "sent" | "compose";
type AuthMode = "login" | "register";

type Email = {
  id: number | string;
  to: string;
  subject: string;
  body: string;
  time: string;
  status: "Scheduled" | "Sent";
};

type User = {
  id?: number;
  name?: string;
  email: string;
};

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getPage(path: string): Page {
  if (path === "/sent") return "sent";
  if (path === "/compose") return "compose";
  return "scheduled";
}

function extractRows(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.emails)) return data.emails;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  return [];
}

function mapEmails(
  data: any,
  status: "Scheduled" | "Sent"
): Email[] {
  return extractRows(data).map((item: any, index: number) => ({
    id: item.id ?? item.email_id ?? index,
    to:
      item.recipient_email ??
      item.recipientEmail ??
      item.to ??
      "Unknown",
    subject: item.subject ?? "(No subject)",
    body: item.body ?? item.message ?? "",
    time:
      item.sent_at ??
      item.sentAt ??
      item.scheduled_at ??
      item.scheduledAt ??
      item.created_at ??
      "",
    status,
  }));
}

function formatDate(value: string) {
  if (!value) return "Time not available";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const [token, setToken] = useState(
    () => localStorage.getItem("token") || ""
  );

  const [user, setUser] = useState<User | null>(() => {
    try {
      const saved = localStorage.getItem("user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [authMode, setAuthMode] = useState<AuthMode>("login");

  const page = getPage(location.pathname);

  const [scheduled, setScheduled] = useState<Email[]>([]);
  const [sent, setSent] = useState<Email[]>([]);

  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [deletingId, setDeletingId] = useState<
    string | number | null
  >(null);

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");

  const [recipients, setRecipients] = useState<string[]>([]);
  const [manualEmail, setManualEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [delaySeconds, setDelaySeconds] = useState(5);
  const [hourlyLimit, setHourlyLimit] = useState(100);
  const [uploadMessage, setUploadMessage] = useState("");

  // GMAIL STATES
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState("");
  const [gmailLoading, setGmailLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isLoggedIn = Boolean(token);

  // LOAD GMAIL CONNECTION STATUS
  const loadGmailStatus = useCallback(async () => {
    if (!localStorage.getItem("token")) {
      setGmailConnected(false);
      setGmailEmail("");
      return;
    }

    setGmailLoading(true);

    try {
      const data: any = await getGmailStatus();

      setGmailConnected(Boolean(data.connected));
      setGmailEmail(data.gmailEmail || "");
    } catch (err) {
      setGmailConnected(false);
      setGmailEmail("");
      console.error("Gmail status error:", err);
    } finally {
      setGmailLoading(false);
    }
  }, []);

  // GOOGLE LOGIN + GMAIL CALLBACK
  useEffect(() => {
    if (!location.hash) return;

    const params = new URLSearchParams(
      location.hash.slice(1)
    );

    // GMAIL CONNECT SUCCESS
    const gmailConnectedEmail = params.get("gmail_connected");

    if (gmailConnectedEmail) {
      setError("");
      setSuccess(
        `Gmail connected successfully: ${gmailConnectedEmail}`
      );

      void loadGmailStatus();

      navigate(
        `${location.pathname}${location.search}`,
        { replace: true }
      );

      return;
    }

    // GMAIL CONNECT ERROR
    const gmailError = params.get("gmail_error");

    if (gmailError) {
      setError(gmailError);

      navigate(
        `${location.pathname}${location.search}`,
        { replace: true }
      );

      return;
    }

    // GOOGLE LOGIN ERROR
    const googleError = params.get("error");

    if (googleError) {
      setError(googleError);
      navigate("/", { replace: true });
      return;
    }

    // GOOGLE LOGIN SUCCESS
    const googleToken = params.get("token");
    const googleUserData = params.get("user");

    if (!googleToken || !googleUserData) return;

    try {
      const googleUser = JSON.parse(googleUserData);

      localStorage.setItem("token", googleToken);
      localStorage.setItem("user", JSON.stringify(googleUser));

      setToken(googleToken);
      setUser(googleUser);

      setError("");
      setSuccess("");

      navigate("/scheduled", { replace: true });
    } catch {
      setError("Google login response could not be processed.");
      navigate("/", { replace: true });
    }
  }, [
    location.hash,
    location.pathname,
    location.search,
    navigate,
    loadGmailStatus,
  ]);

  // LOAD EMAILS
  const loadEmails = useCallback(async () => {
    if (!localStorage.getItem("token")) return;

    setLoading(true);
    setError("");

    try {
      const [scheduledData, sentData] = await Promise.all([
        getScheduledEmails(),
        getSentEmails(),
      ]);

      setScheduled(mapEmails(scheduledData, "Scheduled"));
      setSent(mapEmails(sentData, "Sent"));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load emails"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  // REFRESH EMAILS AFTER LOGIN
  useEffect(() => {
    if (isLoggedIn) {
      void loadEmails();
      void loadGmailStatus();
    } else {
      setScheduled([]);
      setSent([]);
      setGmailConnected(false);
      setGmailEmail("");
    }
  }, [isLoggedIn, loadEmails, loadGmailStatus]);

  // AUTH NAVIGATION
  useEffect(() => {
    if (!isLoggedIn && location.pathname !== "/") {
      navigate("/", { replace: true });
    }

    if (isLoggedIn && location.pathname === "/") {
      navigate("/scheduled", { replace: true });
    }
  }, [isLoggedIn, location.pathname, navigate]);

  const activeEmails = page === "sent" ? sent : scheduled;

  const filteredEmails = useMemo(() => {
    const query = search.trim().toLowerCase();

    if (!query) return activeEmails;

    return activeEmails.filter((email) =>
      [email.to, email.subject, email.body]
        .join(" ")
        .toLowerCase()
        .includes(query)
    );
  }, [activeEmails, search]);

  const goTo = (nextPage: Page) => {
    const path =
      nextPage === "sent"
        ? "/sent"
        : nextPage === "compose"
          ? "/compose"
          : "/scheduled";

    setError("");
    setSuccess("");
    setSearch("");

    navigate(path);
  };

  function showCompose() {
    setUploadMessage("");
    goTo("compose");
  }

  // LOGIN + REGISTER
  async function handleAuthSubmit(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setError("");
    setSuccess("");
    setSubmitting(true);

    const form = new FormData(event.currentTarget);

    const name = String(form.get("name") || "").trim();
    const email = String(form.get("email") || "")
      .trim()
      .toLowerCase();
    const password = String(form.get("password") || "");

    try {
      const data: any =
        authMode === "register"
          ? await registerUser({
              name,
              email,
              password,
            })
          : await loginUser({
              email,
              password,
            });

      const newToken =
        data.token ??
        data.accessToken ??
        data.access_token ??
        data.data?.token;

      const newUser =
        data.user ??
        data.data?.user ??
        {
          name: name || email.split("@")[0],
          email,
        };

      if (!newToken) {
        throw new Error(
          "Authentication token was not received."
        );
      }

      localStorage.setItem("token", newToken);
      localStorage.setItem("user", JSON.stringify(newUser));

      setToken(newToken);
      setUser(newUser);

      setError("");
      setSuccess("");

      navigate("/scheduled", { replace: true });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : authMode === "register"
            ? "Registration failed"
            : "Login failed"
      );
    } finally {
      setSubmitting(false);
    }
  }

  // GOOGLE LOGIN
  function handleGoogleLogin() {
    const apiUrl =
      import.meta.env.VITE_API_URL || "http://localhost:4000";

    window.location.href = `${apiUrl}/api/auth/google`;
  }

  // GMAIL CONNECT
  async function handleGmailConnect() {
    setError("");
    setSuccess("");
    setGmailLoading(true);

    try {
      await startGmailConnect();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to start Gmail connection"
      );

      setGmailLoading(false);
    }
  }

  // GMAIL DISCONNECT
  async function handleGmailDisconnect() {
    const confirmed = window.confirm(
      "Are you sure you want to disconnect this Gmail account?"
    );

    if (!confirmed) return;

    setError("");
    setSuccess("");
    setGmailLoading(true);

    try {
      await disconnectGmail();

      setGmailConnected(false);
      setGmailEmail("");

      setSuccess("Gmail disconnected successfully.");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to disconnect Gmail"
      );
    } finally {
      setGmailLoading(false);
    }
  }

  // SWITCH LOGIN / REGISTER
  function switchAuthMode(mode: AuthMode) {
    setAuthMode(mode);
    setError("");
    setSuccess("");
  }

  // LOGOUT
  function handleLogout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");

    setToken("");
    setUser(null);

    setScheduled([]);
    setSent([]);
    setRecipients([]);

    setGmailConnected(false);
    setGmailEmail("");

    setError("");
    setSuccess("");
    setAuthMode("login");

    navigate("/", { replace: true });
  }

  // ADD RECIPIENTS
  function addRecipients(raw: string) {
    const found =
      raw.match(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
      ) || [];

    const existing = new Set(
      recipients.map((email) => email.toLowerCase())
    );

    const uniqueNew = Array.from(
      new Set(
        found.map((email) => email.trim().toLowerCase())
      )
    ).filter((email) => !existing.has(email));

    if (recipients.length + uniqueNew.length > 500) {
      setError("Maximum 500 unique recipients are allowed.");
      return;
    }

    setRecipients((current) => [
      ...current,
      ...uniqueNew,
    ]);

    setUploadMessage(
      `${uniqueNew.length} new email(s) added. Total recipients: ${
        recipients.length + uniqueNew.length
      }.`
    );

    setError("");
  }

  // CSV / TXT UPLOAD
  function handleFileUpload(file?: File) {
    if (!file) return;

    const extension = file.name.split(".").pop()?.toLowerCase();

    if (!["csv", "txt"].includes(extension || "")) {
      setError("Please upload a CSV or TXT file.");
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setError("File size must be 2 MB or less.");
      return;
    }

    const reader = new FileReader();

    reader.onload = () => {
      addRecipients(String(reader.result || ""));
    };

    reader.onerror = () => {
      setError("Unable to read the selected file.");
    };

    reader.readAsText(file);
  }

  // MANUAL EMAIL
  function addManualEmail() {
    const email = manualEmail.trim().toLowerCase();

    if (!EMAIL_REGEX.test(email)) {
      setError("Please enter a valid email address.");
      return;
    }

    if (
      recipients.some(
        (item) => item.toLowerCase() === email
      )
    ) {
      setError("This email is already in your recipient list.");
      return;
    }

    if (recipients.length >= 500) {
      setError("Maximum 500 recipients are allowed.");
      return;
    }

    setRecipients((current) => [...current, email]);

    setManualEmail("");
    setError("");
    setUploadMessage("Recipient added successfully.");
  }

  function removeRecipient(email: string) {
    setRecipients((current) =>
      current.filter((item) => item !== email)
    );

    setUploadMessage(`${email} removed from the list.`);
  }

  // SCHEDULE EMAILS
  async function handleSchedule(
    event: React.FormEvent<HTMLFormElement>
  ) {
    event.preventDefault();

    setError("");
    setSuccess("");

    if (!gmailConnected) {
      setError("Please connect your Gmail account before scheduling emails.");
      return;
    }

    if (recipients.length === 0) {
      setError("Please add at least one recipient.");
      return;
    }

    if (!recipients.every((email) => EMAIL_REGEX.test(email))) {
      setError("Your recipient list contains an invalid email.");
      return;
    }

    if (!subject.trim() || !body.trim()) {
      setError("Please enter both subject and email message.");
      return;
    }

    const selectedDate = new Date(scheduledAt);

    if (
      !scheduledAt ||
      Number.isNaN(selectedDate.getTime())
    ) {
      setError("Please select a valid schedule date and time.");
      return;
    }

    if (selectedDate.getTime() <= Date.now()) {
      setError("Schedule time must be in the future.");
      return;
    }

    if (delaySeconds < 1 || delaySeconds > 3600) {
      setError("Delay must be between 1 and 3600 seconds.");
      return;
    }

    if (hourlyLimit < 1 || hourlyLimit > 500) {
      setError("Hourly limit must be between 1 and 500.");
      return;
    }

    setSubmitting(true);

    try {
      const result: any = await scheduleBulkEmailsAPI({
        recipients,
        subject: subject.trim(),
        body: body.trim(),
        scheduledAt: selectedDate.toISOString(),
        delaySeconds,
        hourlyLimit,
      });

      setRecipients([]);
      setManualEmail("");
      setSubject("");
      setBody("");
      setScheduledAt("");
      setUploadMessage("");

      await loadEmails();

      setSuccess(
        result.message ||
          `${result.totalScheduled ?? recipients.length} email(s) scheduled successfully.`
      );

      navigate("/scheduled");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Unable to schedule emails"
      );
    } finally {
      setSubmitting(false);
    }
  }

  // DELETE EMAIL
  async function handleDelete(email: Email) {
    const section =
      email.status === "Scheduled"
        ? "scheduled"
        : "sent";

    const message =
      email.status === "Scheduled"
        ? "Are you sure you want to cancel and delete this scheduled email? It must not be sent after cancellation."
        : "Are you sure you want to permanently remove this email from your Sent history? This will not delete the recipient's copy.";

    if (!window.confirm(message)) return;

    setDeletingId(email.id);
    setError("");
    setSuccess("");

    try {
      if (section === "scheduled") {
        await deleteScheduledEmailAPI(email.id);

        setScheduled((current) =>
          current.filter((item) => item.id !== email.id)
        );

        setSuccess("Scheduled email cancelled and deleted.");
      } else {
        await deleteSentEmailAPI(email.id);

        setSent((current) =>
          current.filter((item) => item.id !== email.id)
        );

        setSuccess("Email removed from Sent history.");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to delete email"
      );
    } finally {
      setDeletingId(null);
    }
  }

  // LOGIN / REGISTER SCREEN
  if (!isLoggedIn) {
    return (
      <main className="login-screen">
        <section className="login-card">
          <div className="brand-mark">R</div>

          <p className="eyebrow">REACHINBOX WORKSPACE</p>

          <h1>
            {authMode === "register"
              ? "Create your account"
              : "Welcome back"}
          </h1>

          <p className="muted">
            {authMode === "register"
              ? "Create an account to start managing your email campaigns."
              : "Sign in to manage your email campaigns."}
          </p>

          {error && (
            <div className="alert alert-error">{error}</div>
          )}

          <form
            onSubmit={handleAuthSubmit}
            className="login-form"
          >
            {authMode === "register" && (
              <>
                <label htmlFor="register-name">
                  Full name
                </label>

                <input
                  id="register-name"
                  name="name"
                  type="text"
                  placeholder="Enter your full name"
                  autoComplete="name"
                  minLength={2}
                  required
                />
              </>
            )}

            <label htmlFor="login-email">
              Email address
            </label>

            <input
              id="login-email"
              name="email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              required
            />

            <label htmlFor="login-password">
              Password
            </label>

            <input
              id="login-password"
              name="password"
              type="password"
              placeholder="Enter your password"
              autoComplete={
                authMode === "register"
                  ? "new-password"
                  : "current-password"
              }
              minLength={8}
              required
            />

            {authMode === "register" && (
              <p className="password-hint">
                Password must contain at least 8 characters.
              </p>
            )}

            <button
              type="submit"
              className="primary-button full-button"
              disabled={submitting}
            >
              {submitting
                ? authMode === "register"
                  ? "Creating account..."
                  : "Signing in..."
                : authMode === "register"
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>

          <div className="auth-switch">
            {authMode === "login" ? (
              <>
                Don't have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchAuthMode("register")}
                >
                  Create account
                </button>
              </>
            ) : (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => switchAuthMode("login")}
                >
                  Sign in
                </button>
              </>
            )}
          </div>

          <div className="login-divider">
            <span>OR CONTINUE WITH</span>
          </div>

          <button
            type="button"
            className="google-login-button"
            onClick={handleGoogleLogin}
          >
            <svg
              viewBox="0 0 48 48"
              width="21"
              height="21"
              aria-hidden="true"
            >
              <path
                fill="#4285F4"
                d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.7c3.9-3.6 6-8.9 6-15z"
              />
              <path
                fill="#34A853"
                d="M24 44c5.5 0 10.1-1.8 13.5-4.9l-6.7-5.1c-1.8 1.2-4.1 2-6.8 2-5.2 0-9.6-3.5-11.2-8.2H5.9v5.2A20 20 0 0 0 24 44z"
              />
              <path
                fill="#FBBC05"
                d="M12.8 27.8a12 12 0 0 1 0-7.6V15H5.9a20 20 0 0 0 0 18z"
              />
              <path
                fill="#EA4335"
                d="M24 12.1c3 0 5.7 1 7.8 3.1l5.8-5.8C34.1 6 29.5 4 24 4A20 20 0 0 0 5.9 15l6.9 5.2c1.6-4.7 6-8.1 11.2-8.1z"
              />
            </svg>

            Continue with Google
          </button>

          <p className="login-footnote">
            Secure bulk email scheduling workspace
          </p>
        </section>
      </main>
    );
  }

  // MAIN DASHBOARD
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark small-mark">R</div>

          <div>
            <strong>ReachInbox</strong>
            <span>EMAIL WORKSPACE</span>
          </div>
        </div>

        <button
          className="compose-button"
          onClick={showCompose}
        >
          <span>＋</span> Compose email
        </button>

        <div className="nav-label">WORKSPACE</div>

        <button
          className={`nav-item ${
            page === "scheduled" ? "active" : ""
          }`}
          onClick={() => goTo("scheduled")}
        >
          <span className="nav-icon">◷</span>
          <span>Scheduled</span>
          <span className="nav-count">{scheduled.length}</span>
        </button>

        <button
          className={`nav-item ${
            page === "sent" ? "active" : ""
          }`}
          onClick={() => goTo("sent")}
        >
          <span className="nav-icon">➤</span>
          <span>Sent</span>
          <span className="nav-count">{sent.length}</span>
        </button>

        <div className="sidebar-bottom">
          <div className="user-card">
            <div className="user-avatar">
              {(user?.name || user?.email || "U")
                .charAt(0)
                .toUpperCase()}
            </div>

            <div className="user-details">
              <strong>{user?.name || "My Account"}</strong>
              <span>{user?.email || "Signed in"}</span>
            </div>
          </div>

          {/* GMAIL CONNECTION CARD */}
          <div className="gmail-card">
            <div className="gmail-card-heading">
              <strong>Gmail Account</strong>

              <span
                className={`gmail-status ${
                  gmailConnected
                    ? "connected"
                    : "not-connected"
                }`}
              >
                {gmailLoading
                  ? "Checking..."
                  : gmailConnected
                    ? "Connected"
                    : "Not connected"}
              </span>
            </div>

            {gmailConnected ? (
              <>
                <p className="gmail-account-email">
                  {gmailEmail}
                </p>

                <button
                  type="button"
                  className="gmail-disconnect-button"
                  onClick={() => void handleGmailDisconnect()}
                  disabled={gmailLoading}
                >
                  {gmailLoading
                    ? "Please wait..."
                    : "Disconnect Gmail"}
                </button>
              </>
            ) : (
              <>
                <p className="gmail-account-email">
                  Connect your Gmail to send emails from your own account.
                </p>

                <button
                  type="button"
                  className="gmail-connect-button"
                  onClick={() => void handleGmailConnect()}
                  disabled={gmailLoading}
                >
                  {gmailLoading
                    ? "Connecting..."
                    : "Connect Gmail"}
                </button>
              </>
            )}
          </div>

          <button
            className="logout-button"
            onClick={handleLogout}
          >
            ↪ <span>Log out</span>
          </button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <span className="topbar-kicker">
              YOUR WORKSPACE
            </span>

            <h2>
              {page === "compose"
                ? "Compose email"
                : page === "sent"
                  ? "Sent emails"
                  : "Scheduled emails"}
            </h2>
          </div>

          <button
            className="refresh-button"
            onClick={() => {
              void loadEmails();
              void loadGmailStatus();
            }}
            disabled={loading || gmailLoading}
          >
            ↻ <span>Refresh</span>
          </button>
        </header>

        <section className="content-area">
          {error && (
            <div className="alert alert-error">{error}</div>
          )}

          {success && (
            <div className="alert alert-success">{success}</div>
          )}

          {page === "compose" ? (
            <section className="compose-card">
              <div className="section-heading">
                <span className="eyebrow">NEW CAMPAIGN</span>

                <h3>Create your email</h3>

                <p className="muted">
                  Upload a recipient list or add email addresses manually.
                </p>
              </div>

              {!gmailConnected && (
                <div className="alert alert-error">
                  Gmail is not connected. Connect your Gmail account from the sidebar before scheduling emails.
                </div>
              )}

              <form
                onSubmit={handleSchedule}
                className="compose-form"
              >
                <label>Recipients</label>

                <div className="upload-actions">
                  <button
                    type="button"
                    className="upload-button"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    ↑ Upload CSV / TXT
                  </button>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.txt,text/csv,text/plain"
                    hidden
                    onChange={(event) => {
                      handleFileUpload(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />

                  <span>
                    Maximum 500 unique recipients · 2 MB file size
                  </span>
                </div>

                <div className="manual-add-row">
                  <input
                    type="email"
                    value={manualEmail}
                    onChange={(event) =>
                      setManualEmail(event.target.value)
                    }
                    placeholder="Add an email address manually"
                  />

                  <button
                    type="button"
                    className="secondary-button"
                    onClick={addManualEmail}
                  >
                    Add email
                  </button>
                </div>

                {uploadMessage && (
                  <div className="upload-success">
                    {uploadMessage}
                  </div>
                )}

                <div className="recipient-heading">
                  <strong>Recipient list</strong>
                  <span>{recipients.length} / 500</span>
                </div>

                {recipients.length > 0 ? (
                  <div className="recipient-list">
                    {recipients.map((email) => (
                      <div className="recipient-chip" key={email}>
                        <span>{email}</span>

                        <button
                          type="button"
                          aria-label={`Remove ${email}`}
                          onClick={() => removeRecipient(email)}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="recipient-empty">
                    No recipients added. Upload a CSV/TXT file or add an email above.
                  </div>
                )}

                <label htmlFor="subject">Subject</label>

                <input
                  id="subject"
                  value={subject}
                  onChange={(event) =>
                    setSubject(event.target.value)
                  }
                  placeholder="Enter email subject"
                  required
                />

                <label htmlFor="message">Message</label>

                <textarea
                  id="message"
                  className="message-input"
                  value={body}
                  onChange={(event) =>
                    setBody(event.target.value)
                  }
                  placeholder="Write your email message here..."
                  rows={8}
                  required
                />

                <div className="form-divider" />

                <h4>Delivery settings</h4>

                <div className="settings-grid">
                  <div>
                    <label htmlFor="schedule-time">
                      Schedule date & time
                    </label>

                    <input
                      id="schedule-time"
                      type="datetime-local"
                      value={scheduledAt}
                      onChange={(event) =>
                        setScheduledAt(event.target.value)
                      }
                      min={
                        new Date(
                          Date.now() -
                            new Date().getTimezoneOffset() * 60000
                        )
                          .toISOString()
                          .slice(0, 16)
                      }
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="delay">
                      Delay (seconds)
                    </label>

                    <input
                      id="delay"
                      type="number"
                      min={1}
                      max={3600}
                      value={delaySeconds}
                      onChange={(event) =>
                        setDelaySeconds(Number(event.target.value))
                      }
                      required
                    />
                  </div>

                  <div>
                    <label htmlFor="hourly-limit">
                      Hourly limit
                    </label>

                    <input
                      id="hourly-limit"
                      type="number"
                      min={1}
                      max={500}
                      value={hourlyLimit}
                      onChange={(event) =>
                        setHourlyLimit(Number(event.target.value))
                      }
                      required
                    />
                  </div>
                </div>

                <div className="form-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => goTo("scheduled")}
                  >
                    Cancel
                  </button>

                  <button
                    type="submit"
                    className="primary-button"
                    disabled={submitting || !gmailConnected}
                  >
                    {submitting
                      ? "Scheduling..."
                      : "◷ Schedule emails"}
                  </button>
                </div>
              </form>
            </section>
          ) : (
            <>
              <div className="stats-grid">
                <article className="stat-card">
                  <div className="stat-icon purple">◷</div>
                  <div>
                    <span>Scheduled emails</span>
                    <strong>{scheduled.length}</strong>
                  </div>
                </article>

                <article className="stat-card">
                  <div className="stat-icon green">➤</div>
                  <div>
                    <span>Sent emails</span>
                    <strong>{sent.length}</strong>
                  </div>
                </article>

                <article className="stat-card">
                  <div className="stat-icon blue">✉</div>
                  <div>
                    <span>Total emails</span>
                    <strong>
                      {scheduled.length + sent.length}
                    </strong>
                  </div>
                </article>
              </div>

              <section className="email-section">
                <div className="list-toolbar">
                  <div>
                    <h3>
                      {page === "sent"
                        ? "Sent messages"
                        : "Upcoming emails"}
                    </h3>

                    <p className="muted">
                      {page === "sent"
                        ? "Emails processed by your scheduler."
                        : "Emails waiting for scheduled delivery."}
                    </p>
                  </div>

                  <input
                    className="search-input"
                    value={search}
                    onChange={(event) =>
                      setSearch(event.target.value)
                    }
                    placeholder="⌕ Search emails..."
                  />
                </div>

                {loading ? (
                  <div className="empty-state">
                    <div className="loading-spinner" />
                    <h3>Loading emails...</h3>
                  </div>
                ) : filteredEmails.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon">
                      {page === "sent" ? "➤" : "◷"}
                    </div>

                    <h3>
                      {search
                        ? "No matching emails"
                        : page === "sent"
                          ? "No sent emails yet"
                          : "No scheduled emails"}
                    </h3>

                    <p>
                      {search
                        ? "Try another search term."
                        : page === "sent"
                          ? "Sent emails will appear here after the worker processes them."
                          : "Your scheduled emails will appear here after you create a campaign."}
                    </p>

                    {!search && page === "scheduled" && (
                      <button
                        className="primary-button"
                        onClick={showCompose}
                      >
                        ＋ Compose your first email
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="email-list">
                    {filteredEmails.map((email) => (
                      <article
                        className="email-row"
                        key={email.id}
                      >
                        <div className="email-symbol">
                          {email.status === "Sent" ? "➤" : "◷"}
                        </div>

                        <div className="email-main">
                          <div className="email-row-top">
                            <strong>{email.subject}</strong>

                            <span
                              className={`status-pill ${
                                email.status === "Sent"
                                  ? "sent"
                                  : "scheduled"
                              }`}
                            >
                              {email.status}
                            </span>
                          </div>

                          <span className="email-recipient">
                            To: {email.to}
                          </span>

                          {email.body && (
                            <p className="email-preview">
                              {email.body}
                            </p>
                          )}
                        </div>

                        <time className="email-time">
                          {formatDate(email.time)}
                        </time>

                        <button
                          className="delete-email-button"
                          onClick={() => void handleDelete(email)}
                          disabled={deletingId === email.id}
                          title={
                            email.status === "Scheduled"
                              ? "Cancel scheduled email"
                              : "Remove from sent history"
                          }
                        >
                          {deletingId === email.id
                            ? "Deleting..."
                            : "Delete"}
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;

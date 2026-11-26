
const API_URL =
  import.meta.env.VITE_API_URL || "http://localhost:4000";

async function apiRequest(
  endpoint: string,
  options: RequestInit = {}
) {
  const token = localStorage.getItem("token");
  const headers = new Headers(options.headers);

  if (!(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data.message || `Request failed (${response.status})`
    );
  }

  return data;
}

// LOGIN
export const loginUser = (payload: {
  email: string;
  password: string;
}) =>
  apiRequest("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });

// REGISTER
export const registerUser = (payload: {
  name: string;
  email: string;
  password: string;
}) =>
  apiRequest("/api/auth/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });

// GOOGLE LOGIN
export const startGoogleLogin = () => {
  window.location.href = `${API_URL}/api/auth/google`;
};

// GMAIL STATUS
export const getGmailStatus = () =>
  apiRequest("/api/gmail/status");

// GMAIL CONNECT URL
export const getGmailConnectUrl = () =>
  apiRequest("/api/gmail/connect-url");

// START GMAIL CONNECTION
export const startGmailConnect = async () => {
  const result = await getGmailConnectUrl();

  if (!result.url) {
    throw new Error("Gmail authorization URL not received");
  }

  window.location.href = result.url;
};

// DISCONNECT GMAIL
export const disconnectGmail = () =>
  apiRequest("/api/gmail/disconnect", {
    method: "DELETE",
  });

// GET SCHEDULED EMAILS
export const getScheduledEmails = () =>
  apiRequest("/api/emails/scheduled");

// GET SENT EMAILS
export const getSentEmails = () =>
  apiRequest("/api/emails/sent");

// BULK EMAIL SCHEDULING
export const scheduleBulkEmailsAPI = (payload: {
  recipients: string[];
  subject: string;
  body: string;
  scheduledAt: string;
  delaySeconds: number;
  hourlyLimit: number;
}) =>
  apiRequest("/api/emails/bulk-schedule", {
    method: "POST",
    body: JSON.stringify(payload),
  });

// DELETE SCHEDULED EMAIL
export const deleteScheduledEmailAPI = (
  id: number | string
) =>
  apiRequest(
    `/api/emails/${encodeURIComponent(String(id))}`,
    {
      method: "DELETE",
    }
  );

// DELETE SENT EMAIL
export const deleteSentEmailAPI = (
  id: number | string
) =>
  apiRequest(
    `/api/emails/sent/${encodeURIComponent(String(id))}`,
    {
      method: "DELETE",
    }
  );

function authGuard(req, res, next) {
  if (req.session?.user) return next();
  const accept = String(req.headers.accept || "").toLowerCase();
  const secFetch = String(req.headers["sec-fetch-mode"] || "").toLowerCase();
  const isNavigate = secFetch === "navigate" || secFetch === "nested-navigate" || accept.includes("text/html");
  if (isNavigate) return res.redirect("/login");
  return res.status(401).json({
    ok: false,
    error: "UNAUTHORIZED"
  });
}

export { authGuard };

package com.plagnito.toulouseville;

import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;

final class Api {
    /** Refus du serveur : son message, son code métier (« CONNEXION », « PAS_CONTACT »…) et le statut HTTP. */
    static final class Failure extends IOException {
        final int status; final String code;
        Failure(String message, int status, String code) { super(message); this.status = status; this.code = code == null ? "" : code; }
        /** La session n'ouvre plus rien : il faut se reconnecter. */
        boolean signedOut() { return status == 401 && "CONNEXION".equals(code); }
    }
    private volatile String base;
    Api(String base) { setBase(base); }
    String base() { return base; }
    void setBase(String value) {
        URI uri = URI.create(value.trim());
        boolean local = "127.0.0.1".equals(uri.getHost()) || "localhost".equals(uri.getHost());
        if (uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null || uri.getFragment() != null ||
                !("https".equals(uri.getScheme()) || (local && "http".equals(uri.getScheme())))) throw new IllegalArgumentException("Adresse HTTPS requise (HTTP autorisé uniquement pour le test USB local).");
        base = value.trim().replaceAll("/+$", "");
    }
    JSONObject get(String path) throws Exception { return send("GET", path, null, null); }
    /**
     * Une requête JSON. `token` : le jeton de session du compte, envoyé en en-tête
     * (jamais dans l'adresse, qui finit dans les journaux). null pour les données publiques.
     */
    JSONObject send(String method, String path, JSONObject body, String token) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setConnectTimeout(12000); c.setReadTimeout(50000);
        c.setRequestMethod(method);
        c.setRequestProperty("Accept", "application/json"); c.setRequestProperty("User-Agent", "VillePromenade-Android/" + BuildConfig.VERSION_NAME);
        if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
        try {
            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json; charset=utf-8"); c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = c.getOutputStream()) { out.write(bytes); }
            }
            int code = c.getResponseCode();
            InputStream stream = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            if (stream != null) { byte[] buffer = new byte[8192]; int n; while ((n = stream.read(buffer)) != -1) out.write(buffer, 0, n); }
            String text = out.toString(StandardCharsets.UTF_8.name());
            if (code >= 400) {
                String message = code == 404 ? "Cette version du serveur ne propose pas encore cette fonction." : "Connexion indisponible (HTTP " + code + ").";
                String reason = "";
                try { JSONObject error = new JSONObject(text); message = error.optString("error", message); reason = error.optString("code", ""); } catch (Exception ignored) { }
                throw new Failure(message, code, reason);
            }
            return text.isEmpty() ? new JSONObject() : new JSONObject(text);
        } finally { c.disconnect(); }
    }
    static String q(String s) { try { return URLEncoder.encode(s, "UTF-8"); } catch (UnsupportedEncodingException e) { throw new AssertionError(e); } }
}

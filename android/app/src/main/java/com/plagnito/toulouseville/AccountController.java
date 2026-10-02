package com.plagnito.toulouseville;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.os.*;
import android.text.InputType;
import android.widget.*;
import org.json.*;
import java.time.*;
import java.util.*;

/**
 * Compte Atlas : trajets enregistrés et planifiés, partages avec les amis.
 *
 * Tout vit sur le serveur (/api/compte) : le téléphone n'affiche et ne garde
 * que le jeton de session, le pseudo, et de quoi reposer les rappels sans
 * réseau. La connexion passe par le navigateur du téléphone — l'application ne
 * voit jamais le mot de passe Atlas — et revient par le lien
 * tisseo-ville://auth avec un billet à usage unique, échangé contre le jeton.
 *
 * Sans compte, rien ne change : « Mes déplacements » garde ses arrêts et ses
 * trajets sur le téléphone, comme avant.
 */
final class AccountController {
    private static final int ASK_LOCATION = 87, ASK_NOTIFICATIONS = 88, ASK_REMINDER = 86;
    private static final String[] DAY_NAMES = {"lun", "mar", "mer", "jeu", "ven", "sam", "dim"};
    private static final int[] REMINDERS = {-1, 0, 5, 10, 15, 30, 60};
    private static final String[] REMINDER_LABELS = {"Pas de rappel", "À l’heure du départ", "5 min avant", "10 min avant", "15 min avant", "30 min avant", "1 h avant"};
    private static final int[] DURATIONS = {900, 1800, 3600, 7200, 14400};
    private static final String[] DURATION_LABELS = {"15 minutes", "30 minutes", "1 heure", "2 heures", "4 heures"};

    private final MainActivity host; private final AccountStore store;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private JSONObject state;          // dernière réponse de /api/compte
    private JSONObject pendingShare;   // partage de position en attente d'une autorisation
    private String followed = ""; private boolean followCentered;
    private final Runnable followTick = this::followOnce;

    AccountController(MainActivity host) {
        this.host = host; store = new AccountStore(host);
        // Le processus a été interrompu pendant un partage : le service ne se
        // relance jamais seul, donc le partage est fini. On le dit au serveur.
        // (`sendWith` et non `send` : pendant ce constructeur, l'activité n'a pas
        // encore son contrôleur de compte, donc pas de jeton à lui demander.)
        if (!ShareService.running && !store.shareId().isEmpty()) { String id = store.shareId(); store.shareEnded(); if (connected()) host.sendWith(token(), "DELETE", "/api/compte/partages/" + Api.q(id), null, j -> { }, e -> { }); }
        if (connected()) ReminderReceiver.schedule(host, store.plans());
    }

    String token() { return store.token(host.apiBase()); }
    boolean connected() { return !token().isEmpty(); }
    /** Le serveur a changé : le jeton appartenait à l'ancien. */
    void forget() { stopFollowing(); stopSharing(false); store.signOut(); ReminderReceiver.schedule(host, new JSONArray()); state = null; }

    // ------------------------------------------------------------------ connexion
    void show() {
        if (!connected()) { signedOut(null); return; }
        LinearLayout box = host.column();
        box.addView(host.text("Lecture de ton compte…", 13, MainActivity.MUTED, false));
        host.showSheet("Mon compte", box);
        refresh(this::render);
    }

    private void refresh(Runnable then) {
        host.send("GET", "/api/compte", null, j -> {
            if (!j.optBoolean("connecte")) { forget(); signedOut("Ta session a expiré. Reconnecte-toi."); return; }
            state = j;
            JSONArray plans = j.optJSONArray("planifies");
            store.plans(plans == null ? new JSONArray() : plans);
            ReminderReceiver.schedule(host, store.plans());
            then.run();
        }, this::failed);
    }

    private void failed(Exception e) {
        if (e instanceof Api.Failure && ((Api.Failure) e).signedOut()) { forget(); signedOut("Ta session a expiré. Reconnecte-toi."); return; }
        host.toast(e.getMessage());
    }

    private void signedOut(String notice) {
        host.accountChanged();
        LinearLayout box = host.column();
        if (notice != null) box.addView(host.text(notice, 14, MainActivity.ACCENT, true));
        box.addView(host.text("Avec un compte Atlas, tes trajets te suivent d’un appareil à l’autre : enregistre ceux que tu fais souvent, planifie-les avec un rappel, partage-les avec tes amis.", 14, MainActivity.INK, false));
        box.addView(host.button("Se connecter avec Atlas", () -> host.openUrl(host.apiBase() + "/api/auth/connexion?app=android")));
        box.addView(host.text("La connexion s’ouvre dans ton navigateur : l’application ne voit jamais ton mot de passe. Sans compte, la carte, les itinéraires et « Mes déplacements » restent entièrement utilisables.", 12, MainActivity.MUTED, false));
        host.showSheet("Mon compte", box);
    }

    /** Retour du navigateur : tisseo-ville://auth?billet=… */
    void redeem(String ticket) {
        if (ticket == null || ticket.isEmpty()) { host.toast("Lien de connexion incomplet."); return; }
        try {
            host.send("POST", "/api/auth/echange", new JSONObject().put("billet", ticket), j -> {
                JSONObject who = j.optJSONObject("compte");
                String jeton = j.optString("jeton");
                if (jeton.isEmpty() || who == null) { host.toast("Connexion incomplète. Recommence."); return; }
                store.signIn(host.apiBase(), jeton, who.optString("pseudo"));
                host.toast("Connecté : " + who.optString("pseudo"));
                host.accountChanged();
                show();
            }, e -> host.toast(e.getMessage()));
        } catch (JSONException ignored) { }
    }

    // --------------------------------------------------------------------- écran
    private List<JSONObject> list(JSONObject parent, String key) {
        List<JSONObject> out = new ArrayList<>();
        JSONArray a = parent == null ? null : parent.optJSONArray(key);
        for (int i = 0; a != null && i < a.length(); i++) if (a.optJSONObject(i) != null) out.add(a.optJSONObject(i));
        return out;
    }
    private static String place(JSONObject p) { return p == null ? "ici" : p.optString("texte"); }
    private static String route(JSONObject t) { return place(t.optJSONObject("de")) + " → " + place(t.optJSONObject("a")); }
    private static int[] days(JSONObject p) { JSONArray a = p.optJSONArray("jours"); int[] out = new int[a == null ? 0 : a.length()]; for (int i = 0; i < out.length; i++) out[i] = a.optInt(i); return out; }
    private static String rhythm(JSONObject p) { return PlanRules.rhythm(p.optString("mode"), p.optString("heure"), p.isNull("date") ? null : p.optString("date"), days(p)); }
    private static String names(JSONObject share) { List<String> n = new ArrayList<>(); JSONArray a = share.optJSONArray("vers"); for (int i = 0; a != null && i < a.length(); i++) n.add(a.optJSONObject(i).optString("pseudo")); return String.join(", ", n); }

    private void render() {
        if (state == null) return;
        LinearLayout box = host.column();
        box.addView(host.text("Connecté : " + state.optJSONObject("compte").optString("pseudo"), 14, MainActivity.MUTED, false));

        box.addView(host.text("Mes trajets", 17, MainActivity.INK, true));
        List<JSONObject> trips = list(state, "trajets");
        if (trips.isEmpty()) box.addView(host.text("Enregistre un trajet que tu fais souvent : il sera aussi sur le site et tes autres appareils.", 13, MainActivity.MUTED, false));
        for (JSONObject t : trips) box.addView(host.resultRow(t.optString("nom"), route(t), t.optInt("utilisations") > 0 ? "Utilisé " + t.optInt("utilisations") + " fois" : "Jamais calculé", () -> tripActions(t)));
        box.addView(host.button("Enregistrer un trajet", () -> tripDialog()));

        box.addView(host.text("Planifiés", 17, MainActivity.INK, true));
        List<JSONObject> plans = list(state, "planifies");
        if (plans.isEmpty()) box.addView(host.text("Un trajet à faire un jour précis, ou chaque semaine à la même heure : planifie-le depuis un trajet enregistré.", 13, MainActivity.MUTED, false));
        for (JSONObject p : plans) box.addView(host.resultRow(p.optString("nom"), route(p) + "\n" + rhythm(p),
                p.optBoolean("passe") ? "Passé" : "Prochaine fois : " + PlanRules.when(p.optLong("prochaine")) + (p.isNull("rappel_min") ? "" : " · rappel"), () -> planActions(p)));

        box.addView(host.text("Avec mes amis", 17, MainActivity.INK, true));
        JSONObject shares = state.optJSONObject("partages");
        boolean sharingHere = ShareService.running && !store.shareId().isEmpty();
        if (sharingHere) {
            box.addView(host.text("Ta position est partagée avec " + store.shareNames() + " jusqu’à " + PlanRules.clock(store.shareExpire()) + ".\n" + store.shareStatus(), 14, MainActivity.ACCENT, true));
            box.addView(host.button("Arrêter le partage de position", () -> { stopSharing(true); handler.postDelayed(this::show, 500); }));
        } else box.addView(host.button("Partager ma position", this::positionDialog));
        List<JSONObject> received = list(shares, "recus"), sent = list(shares, "envoyes");
        if (received.isEmpty() && sent.isEmpty()) box.addView(host.text("Tes amis sont tes contacts Atlas. Partage-leur un trajet ou, pour un temps limité, ta position.", 13, MainActivity.MUTED, false));
        if (!received.isEmpty()) box.addView(host.text("Partagé avec moi", 14, MainActivity.INK, true));
        for (JSONObject s : received) box.addView(host.resultRow(s.optJSONObject("de").optString("pseudo"), shareText(s), s.optString("id").equals(followed) ? "Suivi sur la carte" : shareHint(s), () -> receivedActions(s)));
        if (!sent.isEmpty()) box.addView(host.text("Ce que je partage", 14, MainActivity.INK, true));
        for (JSONObject s : sent) box.addView(host.resultRow("→ " + names(s), shareText(s), shareHint(s), () -> sentActions(s)));

        box.addView(host.text("Assistants", 17, MainActivity.INK, true));
        box.addView(host.text("ChatGPT ou Claude peuvent gérer tes trajets si tu leur ajoutes le connecteur de Tisséo Live. Tu les autorises, et tu leur retires l’accès, depuis le site.", 13, MainActivity.MUTED, false));
        box.addView(host.button("Gérer mes assistants ↗", () -> host.openUrl(host.apiBase() + "/?compte=1")));

        box.addView(host.text("Mon compte", 17, MainActivity.INK, true));
        box.addView(host.button("Se déconnecter", this::signOut));
        box.addView(host.button("Effacer mes données Tisséo Live", this::eraseDialog));
        box.addView(host.text("Le serveur garde ton pseudo Atlas, tes trajets et tes partages en cours. Les positions partagées ne sont jamais enregistrées.", 12, MainActivity.MUTED, false));
        host.showSheet("Mon compte", box);
    }

    private String shareText(JSONObject s) {
        JSONObject t = s.optJSONObject("trajet");
        String message = s.isNull("message") ? "" : "\n« " + s.optString("message") + " »";
        if ("position".equals(s.optString("type"))) return "Position en direct" + (t == null ? "" : " · vers " + place(t.optJSONObject("a"))) + message;
        if (t == null) return "Trajet" + message;
        return (t.isNull("nom") ? "" : t.optString("nom") + " · ") + route(t) + (t.isNull("heure") || !t.has("heure") ? "" : "\n" + rhythm(t)) + message;
    }
    private String shareHint(JSONObject s) { return "position".equals(s.optString("type")) ? "Jusqu’à " + PlanRules.clock(s.optLong("expire")) : "Trajet partagé"; }

    // ------------------------------------------------------------------- trajets
    void saveJourney(String from, String to) {
        if (!connected()) { host.saveLocalJourney(from, to); return; }
        from = from.trim(); to = to.trim();
        if (from.isEmpty() || to.isEmpty()) { host.toast("Choisis le départ et l’arrivée."); return; }
        try {
            host.send("POST", "/api/compte/trajets", new JSONObject().put("de", from).put("a", to), j -> {
                JSONObject t = j.optJSONObject("trajet");
                host.toast(t != null && t.optBoolean("deja") ? "Ce trajet était déjà dans ton compte." : "Enregistré dans ton compte : " + (t == null ? "" : t.optString("nom")));
            }, this::failed);
        } catch (JSONException ignored) { }
    }

    private void tripDialog() {
        LinearLayout box = host.column(); box.setPadding(host.dp(20), host.dp(12), host.dp(20), host.dp(12));
        EditText from = field(box, "Départ : arrêt, adresse…"), to = field(box, "Arrivée : arrêt, adresse…"), name = field(box, "Nom (facultatif) : Maison → Travail");
        box.addView(host.text("Les lieux sont vérifiés à l’enregistrement : tu verras comment chacun a été compris.", 12, MainActivity.MUTED, false));
        new AlertDialog.Builder(host).setTitle("Enregistrer un trajet").setView(box).setPositiveButton("Enregistrer", (d, w) -> {
            try {
                JSONObject body = new JSONObject().put("de", from.getText().toString().trim()).put("a", to.getText().toString().trim());
                if (!name.getText().toString().trim().isEmpty()) body.put("nom", name.getText().toString().trim());
                host.send("POST", "/api/compte/trajets", body, j -> { host.toast("Trajet enregistré."); show(); }, this::failed);
            } catch (JSONException ignored) { }
        }).setNegativeButton("Annuler", null).show();
    }
    private EditText field(LinearLayout box, String hint) { EditText e = new EditText(host); e.setSingleLine(true); e.setHint(hint); e.setTextSize(14); e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES); box.addView(e); return e; }

    private void tripActions(JSONObject t) {
        new AlertDialog.Builder(host).setTitle(t.optString("nom")).setItems(new String[]{"Calculer maintenant", "Planifier", "Partager avec des amis", "Supprimer"}, (d, i) -> {
            String id = Api.q(t.optString("id"));
            if (i == 0) { host.toast("Calcul de l’itinéraire…"); host.send("GET", "/api/compte/trajets/" + id + "/calcul", null, j -> itinerary(t.optString("nom"), j), this::failed); }
            else if (i == 1) planDialog(t, null);
            else if (i == 2) shareDialog(t);
            else confirm("Supprimer « " + t.optString("nom") + " » ?", () -> host.send("DELETE", "/api/compte/trajets/" + id, null, j -> show(), this::failed));
        }).show();
    }

    private void confirm(String question, Runnable yes) { new AlertDialog.Builder(host).setMessage(question).setPositiveButton("Oui", (d, w) -> yes.run()).setNegativeButton("Annuler", null).show(); }

    /** L'itinéraire tel que le serveur le rédige : les heures, chaque étape, et ce qu'il faut savoir avant de s'y fier. */
    private void itinerary(String title, JSONObject answer) {
        JSONObject i = answer.optJSONObject("itineraire");
        LinearLayout box = host.column();
        if (i == null) { box.addView(host.text("Itinéraire indisponible.", 14, MainActivity.MUTED, false)); host.showSheet(title, box); return; }
        String arrival = i.isNull("arriver_a") ? i.optString("arrivee_estimee_non_fiable", "?") : i.optString("arriver_a");
        box.addView(host.text((i.has("jour") ? i.optString("jour") + "\n" : "") + "Départ " + i.optString("partir_a") + " → arrivée " + arrival, 20, MainActivity.INK, true));
        JSONObject fare = i.optJSONObject("tarif");
        box.addView(host.text(i.optInt("duree_min") + " min · " + (i.optInt("correspondances") == 0 ? "direct" : i.optInt("correspondances") + " correspondance(s)") + (fare == null || fare.isNull("ticket") ? "" : " · " + fare.optString("ticket")), 13, MainActivity.MUTED, false));
        if (answer.has("avertissement")) box.addView(host.text("⚠ " + answer.optString("avertissement"), 13, MainActivity.ACCENT, true));
        JSONArray steps = i.optJSONArray("etapes");
        for (int k = 0; steps != null && k < steps.length(); k++) box.addView(host.text((k + 1) + ". " + steps.optJSONObject(k).optString("instruction"), 15, MainActivity.INK, false));
        JSONArray alerts = i.optJSONArray("alertes");
        for (int k = 0; alerts != null && k < alerts.length(); k++) box.addView(host.text("⚠ " + alerts.optString(k), 13, MainActivity.ACCENT, true));
        if (i.has("attention")) box.addView(host.text("⚠ " + i.optString("attention"), 13, MainActivity.ACCENT, true));
        box.addView(host.text(i.optString("fiabilite"), 12, MainActivity.MUTED, false));
        box.addView(host.button("← Mon compte", this::show));
        host.showSheet(title, box);
    }

    // ----------------------------------------------------------- trajets planifiés
    private void planActions(JSONObject p) {
        boolean past = p.optBoolean("passe");
        String[] items = past ? new String[]{"Changer l’horaire", "Supprimer"} : new String[]{"Itinéraire de la prochaine fois", "Changer l’horaire", "Partager avec des amis", "Supprimer"};
        new AlertDialog.Builder(host).setTitle(p.optString("nom")).setItems(items, (d, i) -> {
            String choice = items[i];
            if (choice.startsWith("Itinéraire")) planItinerary(p.optString("id"), p.optString("nom"));
            else if (choice.startsWith("Changer")) planDialog(p, p);
            else if (choice.startsWith("Partager")) shareDialog(p);
            else confirm("Supprimer « " + p.optString("nom") + " » ?", () -> host.send("DELETE", "/api/compte/planifies/" + Api.q(p.optString("id")), null, j -> show(), this::failed));
        }).show();
    }
    private void planItinerary(String id, String name) { host.toast("Calcul de l’itinéraire…"); host.send("GET", "/api/compte/planifies/" + Api.q(id) + "/calcul", null, j -> itinerary(name, j), this::failed); }

    /** Ouvert depuis la notification d'un rappel. */
    void openPlan(String id) {
        if (!connected()) { show(); return; }
        refresh(() -> { for (JSONObject p : list(state, "planifies")) if (p.optString("id").equals(id)) { planItinerary(id, p.optString("nom")); return; } show(); });
    }

    /** `source` : le trajet (départ, arrivée, nom). `existing` : le trajet planifié à modifier, ou null. */
    private void planDialog(JSONObject source, JSONObject existing) {
        LinearLayout box = host.column(); box.setPadding(host.dp(20), host.dp(12), host.dp(20), host.dp(12));
        box.addView(host.text(route(source), 13, MainActivity.MUTED, false));
        Spinner mode = spinner(box, new String[]{"Partir à", "Arriver avant"}, existing != null && "arriver".equals(existing.optString("mode")) ? 1 : 0);
        final String[] time = {existing == null ? "08:00" : existing.optString("heure", "08:00")};
        Button timeButton = host.button(time[0], () -> { });
        timeButton.setOnClickListener(v -> { String[] hm = time[0].split(":"); new TimePickerDialog(host, (view, h, m) -> { time[0] = String.format(Locale.ROOT, "%02d:%02d", h, m); timeButton.setText(time[0]); }, Integer.parseInt(hm[0]), Integer.parseInt(hm[1]), true).show(); });
        box.addView(timeButton);
        boolean repeated = existing != null && existing.isNull("date");
        Spinner kind = spinner(box, new String[]{"Un jour précis", "Chaque semaine"}, repeated ? 1 : 0);
        final LocalDate[] date = {existing != null && !existing.isNull("date") ? LocalDate.parse(existing.optString("date")) : LocalDate.now(PlanRules.PARIS).plusDays(1)};
        Button dateButton = host.button(date[0].toString(), () -> { });
        dateButton.setOnClickListener(v -> new DatePickerDialog(host, (view, y, m, d) -> { date[0] = LocalDate.of(y, m + 1, d); dateButton.setText(date[0].toString()); }, date[0].getYear(), date[0].getMonthValue() - 1, date[0].getDayOfMonth()).show());
        box.addView(dateButton);
        // Sept cases sur deux lignes : sur une seule, « dim » sortirait de l'écran.
        CheckBox[] checks = new CheckBox[7];
        Set<Integer> chosen = new HashSet<>();
        if (repeated) for (int d : days(existing)) chosen.add(d); else chosen.addAll(Arrays.asList(1, 2, 3, 4, 5));
        LinearLayout first = host.row(), second = host.row();
        for (int d = 0; d < 7; d++) { checks[d] = new CheckBox(host); checks[d].setText(DAY_NAMES[d]); checks[d].setTextSize(13); checks[d].setChecked(chosen.contains(d + 1)); (d < 4 ? first : second).addView(checks[d]); }
        LinearLayout week = host.column(); week.addView(first); week.addView(second); box.addView(week);
        Runnable sync = () -> { boolean each = kind.getSelectedItemPosition() == 1; week.setVisibility(each ? android.view.View.VISIBLE : android.view.View.GONE); dateButton.setVisibility(each ? android.view.View.GONE : android.view.View.VISIBLE); };
        kind.setOnItemSelectedListener(new AdapterView.OnItemSelectedListener() { public void onItemSelected(AdapterView<?> a, android.view.View v, int i, long l) { sync.run(); } public void onNothingSelected(AdapterView<?> a) { } });
        sync.run();
        int current = 0;
        if (existing != null && !existing.isNull("rappel_min")) for (int i = 0; i < REMINDERS.length; i++) if (REMINDERS[i] == existing.optInt("rappel_min")) current = i;
        Spinner reminder = spinner(box, REMINDER_LABELS, current);
        box.addView(host.text("L’itinéraire n’est pas figé : il est recalculé à la consultation, avec les horaires et le trafic du moment." + (ReminderReceiver.exactAllowed(host) ? "" : " Sans l’autorisation « Alarmes et rappels », Android peut retarder un rappel jusqu’à une heure."), 12, MainActivity.MUTED, false));
        new AlertDialog.Builder(host).setTitle(existing == null ? "Planifier « " + source.optString("nom") + " »" : "Changer l’horaire").setView(box).setPositiveButton(existing == null ? "Planifier" : "Enregistrer", (dialog, w) -> {
            try {
                JSONObject body = new JSONObject().put("mode", mode.getSelectedItemPosition() == 1 ? "arriver" : "partir").put("heure", time[0]);
                if (kind.getSelectedItemPosition() == 1) {
                    JSONArray list = new JSONArray(); for (int d = 0; d < 7; d++) if (checks[d].isChecked()) list.put(d + 1);
                    if (list.length() == 0) { host.toast("Coche au moins un jour."); return; }
                    body.put("jours", list);
                } else body.put("date", date[0].toString());
                int minutes = REMINDERS[reminder.getSelectedItemPosition()];
                body.put("rappel_min", minutes < 0 ? JSONObject.NULL : minutes);
                if (existing == null) body.put("nom", source.optString("nom")).put("de", source.optJSONObject("de")).put("a", source.optJSONObject("a"));
                host.send(existing == null ? "POST" : "PUT", "/api/compte/planifies" + (existing == null ? "" : "/" + Api.q(existing.optString("id"))), body, j -> {
                    host.toast(existing == null ? "Trajet planifié." : "Horaire enregistré.");
                    show();
                    // Un rappel sans droit de notifier ne sonnerait jamais : on le demande maintenant.
                    if (minutes >= 0 && Build.VERSION.SDK_INT >= 33 && host.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) host.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, ASK_REMINDER);
                    else if (minutes >= 0) exactAlarmNotice();
                }, this::failed);
            } catch (JSONException ignored) { }
        }).setNegativeButton("Annuler", null).show();
    }
    /**
     * Sans l'autorisation « Alarmes et rappels », Android sert un rappel avec
     * jusqu'à une heure de retard : pour « pars dans 10 minutes », c'est un
     * rappel qui ne sert à rien. On le dit, et on propose le réglage.
     */
    private void exactAlarmNotice() {
        if (ReminderReceiver.exactAllowed(host)) return;
        new AlertDialog.Builder(host).setTitle("Rappel à l’heure")
                .setMessage("Android ne laisse sonner à l’heure que les applications autorisées dans « Alarmes et rappels ». Sans cette autorisation, ton rappel peut arriver avec jusqu’à une heure de retard.")
                .setPositiveButton("Autoriser", (d, w) -> { try { host.startActivity(new Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.parse("package:" + host.getPackageName()))); } catch (RuntimeException e) { host.toast("Réglage introuvable : cherche « Alarmes et rappels » dans les paramètres de l’application."); } })
                .setNegativeButton("Plus tard", null).show();
    }
    private Spinner spinner(LinearLayout box, String[] choices, int selected) { Spinner s = new Spinner(host); s.setAdapter(new ArrayAdapter<>(host, android.R.layout.simple_spinner_dropdown_item, choices)); s.setSelection(Math.max(0, selected)); box.addView(s, new LinearLayout.LayoutParams(-1, host.dp(48))); return s; }

    // ------------------------------------------------------------------- partages
    interface Friends { void ready(List<JSONObject> friends, String manage); }
    private void friends(Friends then) {
        host.send("GET", "/api/compte/amis", null, j -> {
            List<JSONObject> all = list(j, "amis");
            if (all.isEmpty()) {
                new AlertDialog.Builder(host).setTitle("Aucun contact Atlas").setMessage("Tes amis sont tes contacts Atlas. Ajoute-en dans Atlas Contacts, puis reviens.").setPositiveButton("Ouvrir Atlas Contacts ↗", (d, w) -> host.openUrl(j.optString("gerer"))).setNegativeButton("Fermer", null).show();
                return;
            }
            then.ready(all, j.optString("gerer"));
        }, this::failed);
    }
    private CheckBox[] friendChecks(LinearLayout box, List<JSONObject> all) {
        CheckBox[] checks = new CheckBox[all.size()];
        for (int i = 0; i < checks.length; i++) { JSONObject f = all.get(i); checks[i] = new CheckBox(host); checks[i].setText(f.isNull("nom") ? f.optString("pseudo") : f.optString("nom")); checks[i].setTextSize(15); box.addView(checks[i]); }
        return checks;
    }
    private JSONArray chosen(CheckBox[] checks, List<JSONObject> all, List<String> names) { JSONArray ids = new JSONArray(); for (int i = 0; i < checks.length; i++) if (checks[i].isChecked()) { ids.put(all.get(i).optString("id")); names.add(all.get(i).optString("pseudo")); } return ids; }

    /** Partage un trajet enregistré ou planifié. */
    private void shareDialog(JSONObject trip) {
        friends((all, manage) -> {
            LinearLayout box = host.column(); box.setPadding(host.dp(20), host.dp(12), host.dp(20), host.dp(12));
            box.addView(host.text(route(trip) + (trip.has("heure") ? "\n" + rhythm(trip) : ""), 13, MainActivity.MUTED, false));
            CheckBox[] checks = friendChecks(box, all);
            EditText message = field(box, "Un mot pour eux (facultatif)");
            box.addView(host.text("Ils le verront dans Tisséo Live pendant 30 jours, et recevront une carte dans Atlas Contacts.", 12, MainActivity.MUTED, false));
            new AlertDialog.Builder(host).setTitle("Partager « " + trip.optString("nom") + " »").setView(box).setPositiveButton("Partager", (d, w) -> {
                List<String> names = new ArrayList<>(); JSONArray ids = chosen(checks, all, names);
                if (ids.length() == 0) { host.toast("Choisis au moins un ami."); return; }
                try {
                    JSONObject t = new JSONObject().put("nom", trip.optString("nom")).put("de", trip.optJSONObject("de")).put("a", trip.optJSONObject("a"));
                    if (trip.has("heure")) { t.put("heure", trip.optString("heure")).put("mode", trip.optString("mode")); if (!trip.isNull("date")) t.put("date", trip.optString("date")); if (!trip.isNull("jours")) t.put("jours", trip.optJSONArray("jours")); }
                    JSONObject body = new JSONObject().put("type", "trajet").put("amis", ids).put("trajet", t).put("message", message.getText().toString().trim());
                    host.send("POST", "/api/compte/partages", body, j -> { host.toast(j.optInt("prevenus") > 0 ? "Partagé : " + String.join(", ", names) + " est prévenu dans Atlas Contacts." : "Partagé. Tes amis le verront en ouvrant Tisséo Live."); show(); }, this::failed);
                } catch (JSONException ignored) { }
            }).setNegativeButton("Annuler", null).show();
        });
    }

    private void receivedActions(JSONObject s) {
        String id = s.optString("id");
        if ("position".equals(s.optString("type"))) {
            boolean following = id.equals(followed);
            new AlertDialog.Builder(host).setTitle(s.optJSONObject("de").optString("pseudo")).setItems(new String[]{following ? "Ne plus suivre" : "Voir sur la carte", "Retirer de ma liste"}, (d, i) -> {
                if (i == 0) { if (following) { stopFollowing(); show(); } else follow(id); }
                else { if (following) stopFollowing(); host.send("DELETE", "/api/compte/partages/" + Api.q(id), null, j -> show(), this::failed); }
            }).show();
            return;
        }
        JSONObject t = s.optJSONObject("trajet");
        new AlertDialog.Builder(host).setTitle("Trajet de " + s.optJSONObject("de").optString("pseudo")).setItems(new String[]{"Calculer maintenant", "Enregistrer dans mes trajets", "Retirer de ma liste"}, (d, i) -> {
            if (i == 0 && t != null) { host.toast("Calcul de l’itinéraire…"); host.journey(t.optJSONObject("de"), t.optJSONObject("a")); }
            else if (i == 1) host.send("POST", "/api/compte/partages/" + Api.q(id) + "/enregistrer", new JSONObject(), j -> { host.toast(j.has("planifie") ? "Enregistré et planifié chez toi." : "Enregistré dans tes trajets."); show(); }, this::failed);
            else if (i == 2) host.send("DELETE", "/api/compte/partages/" + Api.q(id), null, j -> show(), this::failed);
        }).show();
    }
    private void sentActions(JSONObject s) {
        boolean position = "position".equals(s.optString("type"));
        confirm(position ? "Arrêter de partager ta position avec " + names(s) + " ?" : "Ne plus partager ce trajet avec " + names(s) + " ?", () -> {
            if (position && s.optString("id").equals(store.shareId())) { stopSharing(true); handler.postDelayed(this::show, 500); }
            else host.send("DELETE", "/api/compte/partages/" + Api.q(s.optString("id")), null, j -> show(), this::failed);
        });
    }

    // ------------------------------------------------------- position : émission
    private void positionDialog() {
        friends((all, manage) -> {
            LinearLayout box = host.column(); box.setPadding(host.dp(20), host.dp(12), host.dp(20), host.dp(12));
            CheckBox[] checks = friendChecks(box, all);
            Spinner duration = spinner(box, DURATION_LABELS, 2);
            EditText destination = field(box, "Je vais à… (facultatif)");
            CheckBox assistants = new CheckBox(host); assistants.setText("Autoriser aussi les assistants (ChatGPT, Claude…) de ces amis à lire ma position"); assistants.setTextSize(13); box.addView(assistants);
            box.addView(host.text("Décoché : seuls ces amis la voient, dans Tisséo Live. Une notification reste affichée pendant tout le partage, avec le bouton Arrêter. Ta position n’est jamais enregistrée.", 12, MainActivity.MUTED, false));
            new AlertDialog.Builder(host).setTitle("Partager ma position").setView(box).setPositiveButton("Commencer", (d, w) -> {
                List<String> names = new ArrayList<>(); JSONArray ids = chosen(checks, all, names);
                if (ids.length() == 0) { host.toast("Choisis au moins un ami."); return; }
                try {
                    pendingShare = new JSONObject().put("type", "position").put("amis", ids).put("duree_s", DURATIONS[duration.getSelectedItemPosition()]).put("assistants", assistants.isChecked()).put("_noms", String.join(", ", names));
                    String where = destination.getText().toString().trim();
                    if (!where.isEmpty()) pendingShare.put("trajet", new JSONObject().put("a", where));
                    startSharing();
                } catch (JSONException ignored) { }
            }).setNegativeButton("Annuler", null).show();
        });
    }

    /** Autorisations d'abord, partage ensuite : un refus ne doit pas laisser à l'ami un partage qui n'enverra jamais rien. */
    private void startSharing() {
        if (pendingShare == null) return;
        if (host.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED && host.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            host.requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, ASK_LOCATION); return;
        }
        if (Build.VERSION.SDK_INT >= 33 && host.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED && !pendingShare.optBoolean("_asked")) {
            try { pendingShare.put("_asked", true); } catch (JSONException ignored) { }
            host.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, ASK_NOTIFICATIONS); return;
        }
        JSONObject body = pendingShare; pendingShare = null;
        String names = body.optString("_noms"); body.remove("_noms"); body.remove("_asked");
        host.send("POST", "/api/compte/partages", body, j -> {
            JSONObject share = j.optJSONObject("partage");
            if (share == null) { host.toast("Partage impossible."); return; }
            store.share(share.optString("id"), share.optLong("expire"), names);
            try { host.startForegroundService(new Intent(host, ShareService.class).setAction(ShareService.START)); host.toast("Position partagée avec " + names + "."); }
            catch (RuntimeException e) { store.shareEnded(); host.send("DELETE", "/api/compte/partages/" + Api.q(share.optString("id")), null, x -> { }, x -> { }); host.toast("Le partage ne peut pas démarrer. Vérifie la localisation et réessaie."); }
            handler.postDelayed(this::show, 600);
        }, this::failed);
    }

    private void stopSharing(boolean tell) {
        if (ShareService.running) { try { host.startService(new Intent(host, ShareService.class).setAction(ShareService.STOP)); } catch (RuntimeException ignored) { } }
        else if (tell && !store.shareId().isEmpty()) { String id = store.shareId(); store.shareEnded(); host.send("DELETE", "/api/compte/partages/" + Api.q(id), null, j -> { }, e -> { }); }
    }

    void permissionResult(int code) {
        if (code == ASK_REMINDER) { if (!RefreshJobs.notificationAllowed(host)) host.toast("Notifications non autorisées : le rappel ne sonnera pas. Le trajet reste planifié."); else exactAlarmNotice(); return; }
        if (code == ASK_LOCATION) {
            boolean ok = host.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED || host.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            if (!ok) { pendingShare = null; host.toast("Position non autorisée : rien n’est partagé."); return; }
        }
        startSharing();
    }
    static boolean handles(int code) { return code == ASK_LOCATION || code == ASK_NOTIFICATIONS || code == ASK_REMINDER; }

    // ----------------------------------------------------------- position : suivi
    private void follow(String id) { stopFollowing(); followed = id; followCentered = false; host.closeSheet(); host.toast("Recherche de sa position…"); followOnce(); }
    void stopFollowing() { handler.removeCallbacks(followTick); followed = ""; host.setGeo("friend", host.emptyCollection()); }
    void pause() { handler.removeCallbacks(followTick); }
    void resume() {
        if (!followed.isEmpty()) followOnce();
        // Au retour des réglages : si « Alarmes et rappels » vient d'être accordé,
        // les rappels déjà posés passent à l'heure exacte.
        if (connected()) ReminderReceiver.schedule(host, store.plans());
    }

    private void followOnce() {
        handler.removeCallbacks(followTick);
        if (followed.isEmpty()) return;
        String id = followed;
        host.send("GET", "/api/compte/partages/" + Api.q(id), null, j -> {
            if (!id.equals(followed)) return;
            JSONObject share = j.optJSONObject("partage"), position = share == null ? null : share.optJSONObject("position");
            if (position == null) { if (!followCentered) host.toast("Aucune position reçue pour l’instant."); }
            else {
                boolean fresh = position.optBoolean("fraiche");
                // Une position ancienne est dessinée éteinte : la personne n'y est peut-être plus.
                String label = share.optJSONObject("de").optString("pseudo") + " · " + PlanRules.age(position.optLong("age_s")) + (fresh ? "" : " (ancienne)");
                host.showFriend(position.optDouble("lat"), position.optDouble("lon"), label, fresh, !followCentered);
                followCentered = true;
            }
            handler.postDelayed(followTick, 10_000);
        }, e -> {
            if (!id.equals(followed)) return;
            if (e instanceof Api.Failure && ((Api.Failure) e).status == 404) { stopFollowing(); host.toast("Ce partage de position est terminé."); return; }
            handler.postDelayed(followTick, 20_000);
        });
    }

    // -------------------------------------------------------------------- compte
    private void signOut() {
        stopFollowing(); stopSharing(true);
        String token = token();
        host.sendWith(token, "POST", "/api/auth/deconnexion", new JSONObject(), j -> { }, e -> { });
        store.signOut(); ReminderReceiver.schedule(host, new JSONArray()); state = null;
        host.toast("Déconnecté."); signedOut(null);
    }
    private void eraseDialog() {
        new AlertDialog.Builder(host).setTitle("Tout effacer ?").setMessage("Tes trajets, tes trajets planifiés, tes partages et les accès des assistants seront effacés du serveur. Ton compte Atlas, lui, n’est pas touché.")
                .setPositiveButton("Effacer", (d, w) -> { stopFollowing(); stopSharing(false); host.send("DELETE", "/api/compte", null, j -> { store.signOut(); ReminderReceiver.schedule(host, new JSONArray()); state = null; host.toast("Tes données Tisséo Live sont effacées."); signedOut(null); }, this::failed); })
                .setNegativeButton("Annuler", null).show();
    }
}

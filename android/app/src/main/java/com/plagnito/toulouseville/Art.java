package com.plagnito.toulouseville;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * Le vocabulaire visuel de l'application : des icônes, des pastilles, des
 * cartes illustrées, une frise d'itinéraire, des tuiles de chiffres.
 *
 * Règle suivie partout : une image dit ce dont il s'agit, un titre court dit
 * quoi, une ligne de texte dit le reste. Les explications longues deviennent
 * des notes d'une ligne, chacune avec son pictogramme. Les dessins sont décoratifs
 * pour un lecteur d'écran : ce sont les textes qui portent le sens, et ils
 * restent tous présents.
 *
 * Les dessins viennent de res/drawable (générés par scripts/make-art.mjs).
 */
final class Art {
    private Art() { }

    static final int SAND = Color.rgb(239, 230, 214), MIST = Color.rgb(220, 233, 228), LEAF = Color.rgb(127, 174, 143),
            BLUSH = Color.rgb(243, 217, 204), LINE = Color.rgb(222, 222, 211), OK = Color.rgb(47, 132, 92);

    // ------------------------------------------------------------------ couleurs
    /** La couleur, éclaircie : fond d'une pastille. */
    static int soft(int color) { return mix(color, Color.WHITE, 0.84f); }
    static int mix(int a, int b, float t) {
        return Color.rgb(Math.round(Color.red(a) + (Color.red(b) - Color.red(a)) * t), Math.round(Color.green(a) + (Color.green(b) - Color.green(a)) * t), Math.round(Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t));
    }
    /** Encre lisible sur ce fond : sombre sur clair, blanche sur foncé. */
    static int inkOn(int background) {
        double l = (0.299 * Color.red(background) + 0.587 * Color.green(background) + 0.114 * Color.blue(background)) / 255;
        return l > 0.62 ? MainActivity.INK : Color.WHITE;
    }
    /** Une couleur de catégorie, souvent pastel, assombrie pour rester lisible en trait. */
    static int readable(int color) { return inkOn(color) == Color.WHITE ? color : mix(color, MainActivity.INK, 0.45f); }
    static int parse(String hex, int fallback) {
        if (hex == null || hex.isEmpty()) return fallback;
        try { return Color.parseColor(hex.startsWith("#") ? hex : "#" + hex); } catch (IllegalArgumentException e) { return fallback; }
    }

    // -------------------------------------------------------------------- icônes
    static Drawable tinted(Context c, int res, int color) { Drawable d = c.getDrawable(res).mutate(); d.setTint(color); return d; }
    static ImageView icon(MainActivity h, int res, int color, int sizeDp) {
        ImageView v = new ImageView(h);
        v.setImageDrawable(tinted(h, res, color));
        v.setLayoutParams(new LinearLayout.LayoutParams(h.dp(sizeDp), h.dp(sizeDp)));
        v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return v;
    }
    /** Une icône dans une pastille ronde à sa couleur. */
    static View bubble(MainActivity h, int res, int color, int sizeDp) {
        FrameLayout f = new FrameLayout(h);
        GradientDrawable bg = new GradientDrawable(); bg.setShape(GradientDrawable.OVAL); bg.setColor(soft(color)); f.setBackground(bg);
        int inner = Math.round(sizeDp * 0.56f);
        ImageView i = icon(h, res, color, inner);
        f.addView(i, new FrameLayout.LayoutParams(h.dp(inner), h.dp(inner), Gravity.CENTER));
        f.setLayoutParams(new LinearLayout.LayoutParams(h.dp(sizeDp), h.dp(sizeDp)));
        f.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return f;
    }
    /** La pastille d'une catégorie de lieux : son fond pastel, son icône dans la même teinte, foncée. */
    static View placeBubble(MainActivity h, String category, int color, int sizeDp) {
        FrameLayout f = new FrameLayout(h);
        GradientDrawable bg = new GradientDrawable(); bg.setShape(GradientDrawable.OVAL); bg.setColor(mix(color, Color.WHITE, 0.5f)); f.setBackground(bg);
        int inner = Math.round(sizeDp * 0.56f);
        f.addView(icon(h, category(category), mix(color, MainActivity.INK, 0.72f), inner), new FrameLayout.LayoutParams(h.dp(inner), h.dp(inner), Gravity.CENTER));
        f.setLayoutParams(new LinearLayout.LayoutParams(h.dp(sizeDp), h.dp(sizeDp)));
        f.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return f;
    }
    /** Pose une icône devant le libellé d'un bouton. */
    static Button withIcon(MainActivity h, Button b, int res, int color) {
        Drawable d = tinted(h, res, color); d.setBounds(0, 0, h.dp(18), h.dp(18));
        b.setCompoundDrawablesRelative(d, null, null, null); b.setCompoundDrawablePadding(h.dp(7));
        return b;
    }
    /** Bouton d'action secondaire : icône puis libellé, alignés à gauche comme une ligne de menu. */
    static Button button(MainActivity h, int res, String label, Runnable action) { Button b = withIcon(h, h.button(label, action), res, MainActivity.INK); b.setGravity(Gravity.START | Gravity.CENTER_VERTICAL); return b; }
    /** Le bouton de l'action principale d'un écran : plein, à l'encre. */
    static Button primary(MainActivity h, int res, String label, Runnable action) {
        Button b = h.button(label, action);
        b.setTextColor(Color.WHITE); b.setTextSize(15); b.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(MainActivity.INK); bg.setCornerRadius(h.dp(14)); b.setBackground(bg);
        b.setMinimumHeight(h.dp(52));
        // Le texte reste centré : l'icône tient dans la marge, pas dans la largeur du libellé.
        b.setPadding(h.dp(18), h.dp(4), h.dp(18), h.dp(4));
        withIcon(h, b, res, Color.WHITE);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2); lp.setMargins(0, h.dp(10), 0, h.dp(8)); b.setLayoutParams(lp);
        return b;
    }

    static int category(String id) {
        switch (id == null ? "" : id) {
            case "bikes": return R.drawable.ic_bike;
            case "parking": return R.drawable.ic_parking;
            case "events": return R.drawable.ic_event;
            case "culture": return R.drawable.ic_culture;
            case "visits": return R.drawable.ic_explore;
            case "food": case "markets": return R.drawable.ic_food;
            case "parks": return R.drawable.ic_park;
            case "sports": return R.drawable.ic_sport;
            case "libraries": return R.drawable.ic_book;
            case "services": return R.drawable.ic_building;
            case "water": return R.drawable.ic_water;
            case "toilets": return R.drawable.ic_toilets;
            case "works": return R.drawable.ic_works;
            case "stops": return R.drawable.ic_stop;
            default: return R.drawable.ic_pin;
        }
    }
    static int mode(String mode) {
        String m = mode == null ? "" : mode.toLowerCase(java.util.Locale.FRENCH);
        if (m.contains("métro") || m.contains("metro")) return R.drawable.ic_metro;
        if (m.contains("tram")) return R.drawable.ic_tram;
        if (m.contains("téléo") || m.contains("teleo") || m.contains("câble")) return R.drawable.ic_cable;
        return R.drawable.ic_bus;
    }
    static int weather(int code) { return code == 0 ? R.drawable.ic_sun : R.drawable.ic_cloud; }

    // ------------------------------------------------------------ blocs de texte
    private static LinearLayout.LayoutParams margins(int w, int hgt, MainActivity h, int l, int t, int r, int b) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(w, hgt); lp.setMargins(h.dp(l), h.dp(t), h.dp(r), h.dp(b)); return lp;
    }
    /** Une grande illustration, en tête d'écran. */
    static View hero(MainActivity h, int res) {
        ImageView v = new ImageView(h);
        v.setImageResource(res); v.setAdjustViewBounds(true); v.setScaleType(ImageView.ScaleType.FIT_CENTER);
        // Plafonnée : l'image annonce l'écran, elle ne doit pas repousser le bouton principal hors de vue.
        v.setMaxHeight(h.dp(132));
        v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        v.setLayoutParams(margins(-1, -2, h, 0, 0, 0, 10));
        return v;
    }
    /** Pastille + titre court + une ligne : ce que fait une fonction, sans paragraphe. */
    static View feature(MainActivity h, int res, int color, String title, String caption) {
        LinearLayout row = h.row(); row.setPadding(0, h.dp(7), 0, h.dp(7));
        row.addView(bubble(h, res, color, 42));
        LinearLayout texts = h.column(); texts.setPadding(h.dp(12), 0, 0, 0);
        texts.addView(h.text(title, 15, MainActivity.INK, true));
        if (caption != null && !caption.isEmpty()) texts.addView(h.text(caption, 13, MainActivity.MUTED, false));
        row.addView(texts, new LinearLayout.LayoutParams(0, -2, 1));
        row.setContentDescription(title + ". " + (caption == null ? "" : caption));
        return row;
    }
    /** Une précision d'une ligne, avec son pictogramme (confidentialité, limite, source). */
    static View note(MainActivity h, int res, String text) { return note(h, res, text, MainActivity.MUTED); }
    static View note(MainActivity h, int res, String text, int color) {
        LinearLayout row = new LinearLayout(h); row.setPadding(0, h.dp(5), 0, h.dp(5));
        ImageView i = icon(h, res, color, 16);
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(h.dp(16), h.dp(16)); ip.setMargins(0, h.dp(1), h.dp(8), 0); row.addView(i, ip);
        row.addView(h.text(text, 12, color, false), new LinearLayout.LayoutParams(0, -2, 1));
        return row;
    }
    /** Un avertissement : encadré, pour qu'il ne se perde pas dans le reste. */
    static View warning(MainActivity h, String text) {
        LinearLayout row = new LinearLayout(h); row.setPadding(h.dp(12), h.dp(10), h.dp(12), h.dp(10));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(BLUSH); bg.setCornerRadius(h.dp(12)); row.setBackground(bg);
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(h.dp(18), h.dp(18)); ip.setMargins(0, h.dp(1), h.dp(10), 0);
        row.addView(icon(h, R.drawable.ic_alert, MainActivity.ACCENT, 18), ip);
        row.addView(h.text(text, 13, MainActivity.INK, false), new LinearLayout.LayoutParams(0, -2, 1));
        row.setLayoutParams(margins(-1, -2, h, 0, 6, 0, 6));
        return row;
    }
    /** Un titre de section, avec son icône. */
    static View section(MainActivity h, int res, String title) {
        LinearLayout row = h.row(); row.setPadding(0, h.dp(18), 0, h.dp(6));
        LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(h.dp(20), h.dp(20)); ip.setMargins(0, 0, h.dp(8), 0);
        row.addView(icon(h, res, MainActivity.ACCENT, 20), ip);
        row.addView(h.text(title, 17, MainActivity.INK, true));
        return row;
    }
    /** Quand il n'y a encore rien : un dessin, ce qui manque, comment commencer. */
    static View empty(MainActivity h, int illustration, String title, String caption) {
        LinearLayout box = h.column(); box.setGravity(Gravity.CENTER_HORIZONTAL); box.setPadding(h.dp(8), h.dp(6), h.dp(8), h.dp(10));
        ImageView v = new ImageView(h); v.setImageResource(illustration); v.setAdjustViewBounds(true);
        v.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        box.addView(v, new LinearLayout.LayoutParams(h.dp(196), -2));
        TextView t = h.text(title, 15, MainActivity.INK, true); t.setGravity(Gravity.CENTER); t.setPadding(0, h.dp(8), 0, h.dp(2)); box.addView(t);
        if (caption != null && !caption.isEmpty()) { TextView c = h.text(caption, 13, MainActivity.MUTED, false); c.setGravity(Gravity.CENTER); box.addView(c); }
        return box;
    }
    /** Le code d'une ligne, à sa couleur. */
    static TextView badge(MainActivity h, String text, int background) {
        TextView t = h.text(text, 13, inkOn(background), true);
        t.setGravity(Gravity.CENTER); t.setMinWidth(h.dp(34)); t.setPadding(h.dp(8), h.dp(3), h.dp(8), h.dp(3)); t.setMaxLines(1);
        GradientDrawable bg = new GradientDrawable(); bg.setColor(background); bg.setCornerRadius(h.dp(8)); t.setBackground(bg);
        return t;
    }
    /** Une carte blanche arrondie, pour regrouper. */
    static LinearLayout card(MainActivity h) {
        LinearLayout c = h.column(); c.setPadding(h.dp(14), h.dp(12), h.dp(14), h.dp(12));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(Color.WHITE); bg.setCornerRadius(h.dp(14)); c.setBackground(bg); c.setElevation(h.dp(1));
        c.setLayoutParams(margins(-1, -2, h, 1, 5, 1, 5));
        return c;
    }
    static LinearLayout panel(MainActivity h, int color) {
        LinearLayout c = h.column(); c.setPadding(h.dp(14), h.dp(12), h.dp(14), h.dp(12));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(color); bg.setCornerRadius(h.dp(14)); c.setBackground(bg);
        c.setLayoutParams(margins(-1, -2, h, 0, 5, 0, 5));
        return c;
    }

    // ------------------------------------------------------------ lignes de liste
    /**
     * Une ligne de liste : à gauche ce dont il s'agit (une pastille d'icône, ou le
     * code d'une ligne), puis le nom, une précision, et un indice coloré.
     */
    static View row(MainActivity h, View lead, String name, String subtitle, String hint, Runnable action) {
        LinearLayout r = h.row(); r.setPadding(h.dp(12), h.dp(11), h.dp(10), h.dp(11)); r.setElevation(h.dp(1));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(Color.WHITE); bg.setCornerRadius(h.dp(14)); r.setBackground(bg);
        r.setLayoutParams(margins(-1, -2, h, 1, 5, 1, 3));
        if (lead != null) r.addView(lead);
        LinearLayout texts = h.column(); texts.setPadding(h.dp(12), 0, h.dp(6), 0);
        TextView label = h.text(name, 16, MainActivity.INK, true); label.setMaxLines(2); texts.addView(label);
        if (subtitle != null && !subtitle.isEmpty()) { TextView sub = h.text(subtitle, 13, MainActivity.MUTED, false); sub.setMaxLines(3); texts.addView(sub); }
        if (hint != null && !hint.isEmpty()) texts.addView(h.text(hint, 12, MainActivity.ACCENT, false));
        r.addView(texts, new LinearLayout.LayoutParams(0, -2, 1));
        if (action != null) {
            r.addView(icon(h, R.drawable.ic_chevron, MainActivity.MUTED, 18));
            r.setClickable(true); r.setFocusable(true); r.setOnClickListener(v -> action.run());
        }
        r.setContentDescription(name + ", " + (subtitle == null ? "" : subtitle) + ", " + (hint == null ? "" : hint));
        return r;
    }
    /** Le code d'une ligne en tête de liste : même largeur que les pastilles, pour que les noms s'alignent. */
    static View lineLead(MainActivity h, String line, int color) {
        TextView b = badge(h, line.length() > 6 ? line.substring(0, 6) : line, color);
        b.setTextSize(line.length() > 3 ? 11 : 14);
        b.setPadding(h.dp(3), h.dp(3), h.dp(3), h.dp(3));
        b.setLayoutParams(new LinearLayout.LayoutParams(h.dp(line.length() > 3 ? 54 : 46), h.dp(34)));
        return b;
    }

    // ------------------------------------------------------------------- chiffres
    /** Une tuile : une icône, un chiffre, ce qu'il mesure. */
    static View stat(MainActivity h, int res, int color, String value, String label) {
        LinearLayout c = h.column(); c.setPadding(h.dp(12), h.dp(10), h.dp(12), h.dp(10));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(Color.WHITE); bg.setCornerRadius(h.dp(14)); c.setBackground(bg); c.setElevation(h.dp(1));
        c.addView(bubble(h, res, color, 30));
        TextView v = h.text(value, 19, MainActivity.INK, true); v.setPadding(0, h.dp(6), 0, 0); v.setMaxLines(1); c.addView(v);
        c.addView(h.text(label, 12, MainActivity.MUTED, false));
        c.setContentDescription(label + " : " + value);
        return c;
    }
    /** Des tuiles sur deux colonnes. */
    static View grid(MainActivity h, View... cells) {
        LinearLayout box = h.column();
        for (int i = 0; i < cells.length; i += 2) {
            LinearLayout line = new LinearLayout(h);
            LinearLayout.LayoutParams a = new LinearLayout.LayoutParams(0, -1, 1); a.setMargins(h.dp(1), h.dp(4), h.dp(4), h.dp(4)); line.addView(cells[i], a);
            LinearLayout.LayoutParams b = new LinearLayout.LayoutParams(0, -1, 1); b.setMargins(h.dp(4), h.dp(4), h.dp(1), h.dp(4));
            if (i + 1 < cells.length) line.addView(cells[i + 1], b); else line.addView(new View(h), b);
            box.addView(line);
        }
        return box;
    }
    /** Une jauge horizontale (défi du jour, niveau). */
    static View gauge(MainActivity h, float fraction, int color) {
        final float f = Math.max(0, Math.min(1, fraction));
        final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        View v = new View(h) {
            @Override protected void onDraw(Canvas c) {
                float r = getHeight() / 2f;
                p.setColor(LINE); c.drawRoundRect(new RectF(0, 0, getWidth(), getHeight()), r, r, p);
                if (f > 0) { p.setColor(color); c.drawRoundRect(new RectF(0, 0, Math.max(getHeight(), getWidth() * f), getHeight()), r, r, p); }
            }
        };
        v.setLayoutParams(margins(-1, h.dp(10), h, 0, 6, 0, 6));
        return v;
    }
    /** Un histogramme : une barre par jour, la valeur au-dessus, le jour en dessous. */
    static View bars(MainActivity h, double[] values, String[] labels, String[] captions, int highlight) {
        final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        final float density = h.getResources().getDisplayMetrics().density, scaled = h.getResources().getDisplayMetrics().scaledDensity;
        double max = 0; for (double v : values) max = Math.max(max, v);
        final double top = max;
        StringBuilder spoken = new StringBuilder();
        for (int i = 0; i < values.length; i++) spoken.append(labels[i]).append(" : ").append(captions[i]).append(". ");
        View v = new View(h) {
            @Override protected void onDraw(Canvas c) {
                int n = values.length; float w = getWidth() / (float) n, base = getHeight() - 20 * density, room = base - 20 * density;
                for (int i = 0; i < n; i++) {
                    float cx = w * i + w / 2, bw = Math.min(w * 0.56f, 30 * density);
                    float bh = top <= 0 ? 0 : (float) (room * values[i] / top);
                    p.setStyle(Paint.Style.FILL);
                    p.setColor(LINE); c.drawRoundRect(new RectF(cx - bw / 2, base - 3 * density, cx + bw / 2, base), 2 * density, 2 * density, p);
                    if (bh > 0) { p.setColor(i == highlight ? MainActivity.ACCENT : LEAF); c.drawRoundRect(new RectF(cx - bw / 2, base - Math.max(bh, 4 * density), cx + bw / 2, base), 5 * density, 5 * density, p); }
                    p.setTextAlign(Paint.Align.CENTER);
                    p.setColor(i == highlight ? MainActivity.INK : MainActivity.MUTED); p.setTextSize(11 * scaled); p.setTypeface(Typeface.create("sans-serif", i == highlight ? Typeface.BOLD : Typeface.NORMAL));
                    c.drawText(labels[i], cx, getHeight() - 5 * density, p);
                    if (values[i] > 0) { p.setColor(MainActivity.INK); p.setTextSize(10 * scaled); c.drawText(captions[i], cx, base - Math.max(bh, 4 * density) - 5 * density, p); }
                }
            }
        };
        v.setContentDescription(spoken.toString());
        v.setLayoutParams(margins(-1, h.dp(132), h, 0, 4, 0, 4));
        return v;
    }

    // ----------------------------------------------------------------- itinéraire
    /** Une étape d'itinéraire, quelle que soit la forme sous laquelle le serveur l'a rendue. */
    static final class Step {
        boolean ride;               // en véhicule (sinon : à pied)
        String line = "", mode = "", direction = "", from = "", to = "", depart = "", arrive = "", status = "";
        int minutes, color = MainActivity.INK;
        boolean live;               // heure issue du temps réel
    }

    /** Le rail vertical d'une étape : un trait plein à la couleur de la ligne, des pointillés à pied. */
    private static View rail(MainActivity h, int color, boolean dotted, boolean node, boolean above, boolean below) {
        final Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        final float d = h.getResources().getDisplayMetrics().density;
        return new View(h) {
            @Override protected void onDraw(Canvas c) {
                float x = getWidth() / 2f, y = 11 * d;
                if (dotted) {
                    p.setStyle(Paint.Style.FILL); p.setColor(MainActivity.MUTED);
                    for (float t = 3 * d; t < getHeight(); t += 7 * d) c.drawCircle(x, t, 1.6f * d, p);
                    return;
                }
                p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(5 * d); p.setColor(color); p.setStrokeCap(Paint.Cap.BUTT);
                if (above) c.drawLine(x, 0, x, y, p);
                if (below) c.drawLine(x, y, x, getHeight(), p);
                if (node) {
                    p.setStyle(Paint.Style.FILL); p.setColor(Color.WHITE); c.drawCircle(x, y, 6.5f * d, p);
                    p.setStyle(Paint.Style.STROKE); p.setStrokeWidth(3 * d); p.setColor(color); c.drawCircle(x, y, 6.5f * d, p);
                }
            }
        };
    }
    private static LinearLayout stepRow(MainActivity h, String time, View rail, View content) {
        LinearLayout r = new LinearLayout(h);
        TextView t = h.text(time, 13, MainActivity.INK, true); t.setGravity(Gravity.END); t.setPadding(0, h.dp(2), 0, 0);
        r.addView(t, new LinearLayout.LayoutParams(h.dp(44), -2));
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(h.dp(26), -1); rp.setMargins(h.dp(4), 0, h.dp(6), 0);
        r.addView(rail, rp);
        r.addView(content, new LinearLayout.LayoutParams(0, -2, 1));
        return r;
    }
    /** L'itinéraire en frise : les heures à gauche, la ligne à sa couleur, la marche en pointillés. */
    static View timeline(MainActivity h, List<Step> steps) {
        LinearLayout box = h.column(); box.setPadding(0, h.dp(10), 0, h.dp(6));
        StringBuilder spoken = new StringBuilder();
        for (Step s : steps) {
            if (s.ride) {
                LinearLayout board = h.column(); board.setPadding(0, 0, 0, h.dp(14));
                board.addView(h.text(s.from, 15, MainActivity.INK, true));
                LinearLayout what = h.row(); what.setPadding(0, h.dp(5), 0, h.dp(2));
                what.addView(badge(h, s.line, s.color));
                LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(h.dp(18), h.dp(18)); ip.setMargins(h.dp(8), 0, h.dp(5), 0);
                what.addView(icon(h, mode(s.mode), MainActivity.MUTED, 18), ip);
                TextView label = h.text((s.direction.isEmpty() ? s.mode : "vers " + s.direction) + (s.minutes > 0 ? " · " + s.minutes + " min" : ""), 13, MainActivity.MUTED, false);
                label.setMaxLines(2); what.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
                board.addView(what);
                if (!s.status.isEmpty()) board.addView(h.text(s.status, 12, s.live ? OK : MainActivity.MUTED, false));
                box.addView(stepRow(h, s.depart, rail(h, s.color, false, true, false, true), board));
                LinearLayout alight = h.column(); alight.setPadding(0, 0, 0, h.dp(8));
                alight.addView(h.text(s.to, 15, MainActivity.INK, true));
                box.addView(stepRow(h, s.arrive, rail(h, s.color, false, true, true, false), alight));
                spoken.append("Prendre ").append(s.mode).append(" ").append(s.line).append(s.direction.isEmpty() ? "" : " direction " + s.direction).append(" à ").append(s.from).append(s.depart.isEmpty() ? "" : " à " + s.depart).append(", descendre à ").append(s.to).append(". ");
            } else {
                boolean change = s.from.equals(s.to);
                LinearLayout walk = h.row(); walk.setPadding(0, h.dp(4), 0, h.dp(12));
                LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(h.dp(20), h.dp(20)); ip.setMargins(0, 0, h.dp(7), 0);
                walk.addView(icon(h, R.drawable.ic_walk, MainActivity.MUTED, 20), ip);
                String text = change ? "Correspondance · " + Math.max(1, s.minutes) + " min" : Math.max(1, s.minutes) + " min à pied" + (s.to.isEmpty() ? "" : " jusqu’à " + s.to);
                TextView label = h.text(text, 13, MainActivity.MUTED, false); label.setMaxLines(2);
                walk.addView(label, new LinearLayout.LayoutParams(0, -2, 1));
                box.addView(stepRow(h, "", rail(h, MainActivity.MUTED, true, false, false, false), walk));
                spoken.append(text).append(". ");
            }
        }
        box.setContentDescription(spoken.toString());
        return box;
    }
    /** Le résumé d'un itinéraire d'un coup d'œil : à pied, puis telle ligne, puis telle autre. */
    static View chain(MainActivity h, List<Step> steps) {
        LinearLayout row = h.row(); row.setPadding(0, h.dp(8), 0, h.dp(2));
        // Une seule étape : la frise la montre déjà, le résumé ne ferait que la répéter.
        int visibles = 0; for (Step s : steps) if (s.ride || !s.from.equals(s.to)) visibles++;
        if (visibles < 2) { row.setVisibility(View.GONE); return row; }
        boolean first = true;
        for (Step s : steps) {
            if (!s.ride && s.from.equals(s.to)) continue;
            if (!first) { LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(h.dp(14), h.dp(14)); cp.setMargins(h.dp(3), 0, h.dp(3), 0); row.addView(icon(h, R.drawable.ic_chevron, MainActivity.MUTED, 14), cp); }
            if (s.ride) row.addView(badge(h, s.line, s.color)); else row.addView(icon(h, R.drawable.ic_walk, MainActivity.INK, 22));
            first = false;
        }
        row.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return row;
    }
    /** Une liste numérotée (consignes de marche, étapes d'une balade) : le numéro dans une pastille. */
    static View numbered(MainActivity h, int number, String text, boolean strong) {
        LinearLayout row = new LinearLayout(h); row.setPadding(0, h.dp(5), 0, h.dp(5));
        TextView n = h.text(Integer.toString(number), 12, MainActivity.INK, true); n.setGravity(Gravity.CENTER);
        GradientDrawable bg = new GradientDrawable(); bg.setShape(GradientDrawable.OVAL); bg.setColor(SAND); n.setBackground(bg);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(h.dp(24), h.dp(24)); np.setMargins(0, 0, h.dp(10), 0); row.addView(n, np);
        TextView t = h.text(text, strong ? 16 : 14, MainActivity.INK, strong); t.setPadding(0, h.dp(2), 0, 0);
        row.addView(t, new LinearLayout.LayoutParams(0, -2, 1));
        row.setContentDescription(number + ". " + text);
        return row;
    }
    static List<Step> steps() { return new ArrayList<>(); }

    /** Les arrêts à venir d'un véhicule : une ligne continue à sa couleur, un point par arrêt. `rows` : {délai, nom}. */
    static View stops(MainActivity h, int color, List<String[]> rows) {
        LinearLayout box = h.column(); box.setPadding(0, h.dp(6), 0, h.dp(6));
        for (int i = 0; i < rows.size(); i++) {
            LinearLayout name = h.column(); name.setPadding(0, 0, 0, h.dp(14));
            name.addView(h.text(rows.get(i)[1], i == rows.size() - 1 ? 15 : 14, MainActivity.INK, i == rows.size() - 1));
            LinearLayout r = stepRow(h, rows.get(i)[0], rail(h, color, false, true, i > 0, i < rows.size() - 1), name);
            r.setContentDescription(rows.get(i)[1] + ", " + rows.get(i)[0]);
            box.addView(r);
        }
        return box;
    }
    /** Un prochain passage : la ligne à sa couleur, où elle va, et dans combien de temps — en grand. */
    static View departure(MainActivity h, String line, int color, String destination, String status, boolean live, String wait) {
        LinearLayout r = h.row(); r.setPadding(h.dp(12), h.dp(10), h.dp(12), h.dp(10)); r.setElevation(h.dp(1));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(Color.WHITE); bg.setCornerRadius(h.dp(14)); r.setBackground(bg);
        r.setLayoutParams(margins(-1, -2, h, 1, 4, 1, 4));
        r.addView(lineLead(h, line, color));
        LinearLayout texts = h.column(); texts.setPadding(h.dp(12), 0, h.dp(8), 0);
        TextView d = h.text(destination, 15, MainActivity.INK, true); d.setMaxLines(2); texts.addView(d);
        texts.addView(h.text(status, 12, live ? OK : MainActivity.MUTED, false));
        r.addView(texts, new LinearLayout.LayoutParams(0, -2, 1));
        TextView w = h.text(wait, 18, MainActivity.INK, true); w.setGravity(Gravity.END); r.addView(w);
        r.setContentDescription("Ligne " + line + " vers " + destination + ", " + wait + ", " + status);
        return r;
    }

    /** Un onglet : icône et libellé centrés ensemble, plein quand il est choisi. */
    static final class Tab {
        final LinearLayout view; private final ImageView icon; private final TextView label; private final MainActivity h; private final int res;
        Tab(MainActivity h, int res, String text, Runnable action) {
            this.h = h; this.res = res;
            view = h.row(); view.setGravity(Gravity.CENTER); view.setPadding(h.dp(6), 0, h.dp(6), 0);
            icon = Art.icon(h, res, MainActivity.INK, 18);
            LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(h.dp(18), h.dp(18)); ip.setMargins(0, 0, h.dp(6), 0); view.addView(icon, ip);
            label = h.text(text, 13, MainActivity.INK, false); label.setMaxLines(1); view.addView(label);
            view.setClickable(true); view.setFocusable(true); view.setContentDescription(text);
            view.setOnClickListener(v -> action.run());
            select(false);
        }
        void text(String s) { label.setText(s); view.setContentDescription(s); }
        void select(boolean on) {
            GradientDrawable bg = new GradientDrawable(); bg.setColor(on ? MainActivity.INK : Color.WHITE); bg.setCornerRadius(h.dp(14)); if (!on) bg.setStroke(h.dp(1), LINE);
            view.setBackground(bg); view.setSelected(on);
            label.setTextColor(on ? Color.WHITE : MainActivity.INK); label.setTypeface(Typeface.create("sans-serif", on ? Typeface.BOLD : Typeface.NORMAL));
            icon.setImageDrawable(tinted(h, res, on ? Color.WHITE : MainActivity.INK));
        }
    }
}

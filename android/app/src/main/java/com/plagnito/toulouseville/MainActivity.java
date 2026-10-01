package com.plagnito.toulouseville;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.PointF;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.location.*;
import android.net.Uri;
import android.os.*;
import android.provider.CalendarContract;
import android.view.*;
import android.view.inputmethod.InputMethodManager;
import android.widget.*;
import android.text.*;
import org.json.*;
import org.maplibre.android.MapLibre;
import org.maplibre.android.camera.CameraUpdateFactory;
import org.maplibre.android.geometry.LatLng;
import org.maplibre.android.maps.*;
import org.maplibre.android.style.sources.GeoJsonSource;
import org.maplibre.geojson.Feature;
import org.maplibre.geojson.Point;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.time.*;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.concurrent.*;

/** Écrans Android et rendu MapLibre natifs. Aucune page HTML n'est embarquée. */
public final class MainActivity extends Activity {
    private static final int INK = Color.rgb(37,60,59), PAPER = Color.rgb(248,246,241), ACCENT = Color.rgb(180,91,64), MUTED = Color.rgb(100,112,108);
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newFixedThreadPool(4);
    private final Map<String,JSONObject> catalog = new LinkedHashMap<>(), datasets = new HashMap<>(), favorites = new LinkedHashMap<>();
    private final Set<String> selected = new LinkedHashSet<>(), loading = new HashSet<>();
    private final Map<String,JSONObject> visibleById = new HashMap<>();
    private JSONArray vehicles = new JSONArray(), alerts = new JSONArray(), nearby = new JSONArray();
    private JSONObject weather, isochrone;
    private SharedPreferences prefs;
    private Api api;
    private MapView mapView;
    private MapLibreMap map;
    private Style style;
    private LinearLayout root, chips, results, panel;
    private TextView title, status, today, listTitle;
    private EditText search;
    private Button cityTab, transitTab;
    private String mode = "city", period = "upcoming", eventTag = "", lastError = "";
    private boolean favoritesOnly, openOnly, freeOnly, accessibleOnly, vegetarianOnly, showTransport, showStops, resumed;
    private int generation, minutes = 10, pageSize = 40, isoTicket;
    private double originLat = 43.6047, originLon = 1.4442;
    private boolean haveLocation;
    private double locationLat, locationLon;
    private LatLng detailOrigin = new LatLng(43.6047,1.4442);
    private String detailPlaceId = "";
    private Dialog detailDialog;
    private LocationManager locationManager;
    private LocationListener locationListener;
    private int refreshTick;
    private final Runnable refreshTask = new Runnable() { public void run() { if (!resumed) return; if (mode.equals("transport") || showTransport) loadVehicles(); if(++refreshTick%4==0&&mode.equals("city")){if(selected.contains("bikes"))loadPlaces("bikes");if(openOnly)for(String id:selected)if(!id.equals("bikes"))loadPlaces(id);}ui.postDelayed(this,15000); } };
    private final Runnable searchTask = () -> { pageSize = 40; render(); };

    @Override public void onCreate(Bundle state) {
        super.onCreate(state); MapLibre.getInstance(this);
        prefs = getSharedPreferences("toulouse-ville",MODE_PRIVATE);
        api = new Api(prefs.getString("api", BuildConfig.API_URL));
        if (BuildConfig.DEBUG && getIntent().hasExtra("api_url")) {
            try { api.setBase(getIntent().getStringExtra("api_url")); prefs.edit().putString("api",api.base()).apply(); } catch (Exception ignored) { }
        }
        mode = prefs.getString("mode","city");
        selected.addAll(prefs.getStringSet("categories",new HashSet<>(Arrays.asList("events","parks","culture","bikes","parking","services"))));
        try { JSONObject saved = new JSONObject(prefs.getString("favorites","{}")); Iterator<String> keys = saved.keys(); while(keys.hasNext()) { String key=keys.next(); favorites.put(key,saved.getJSONObject(key)); } } catch(Exception ignored) { }
        buildUI(state); loadCatalog(); loadToday();
    }
    private int dp(float x) { return Math.round(x*getResources().getDisplayMetrics().density); }
    private GradientDrawable rounded(int color, int border) { GradientDrawable d = new GradientDrawable(); d.setColor(color); d.setCornerRadius(dp(14)); if(border!=0)d.setStroke(dp(1),border); return d; }
    private LinearLayout column() { LinearLayout l=new LinearLayout(this); l.setOrientation(LinearLayout.VERTICAL); return l; }
    private LinearLayout row() { LinearLayout l=new LinearLayout(this); l.setGravity(Gravity.CENTER_VERTICAL); return l; }
    private TextView text(String s,int size,int color,boolean bold) { TextView t=new TextView(this); t.setText(s); t.setTextSize(size); t.setTextColor(color); if(bold)t.setTypeface(Typeface.create("sans-serif",Typeface.BOLD)); return t; }
    private Button button(String label,Runnable action) { Button b=new Button(this); b.setText(label); b.setTextSize(12); b.setAllCaps(false); b.setTextColor(INK); b.setMinWidth(0); b.setMinimumWidth(0); b.setMinimumHeight(dp(44)); b.setPadding(dp(12),dp(4),dp(12),dp(4)); b.setBackground(rounded(Color.WHITE,Color.rgb(222,222,211))); b.setOnClickListener(v->action.run()); return b; }
    private void addChip(String label,Runnable action) { Button b=button(label,action); LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-2,dp(44)); lp.setMargins(0,0,dp(6),0); chips.addView(b,lp); }
    private void buildUI(Bundle state) {
        root=column(); root.setBackgroundColor(PAPER); setContentView(root);
        root.setOnApplyWindowInsetsListener((v,insets)->{ if(Build.VERSION.SDK_INT>=30){android.graphics.Insets bars=insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());root.setPadding(bars.left,bars.top,bars.right,bars.bottom);}else root.setPadding(insets.getSystemWindowInsetLeft(),insets.getSystemWindowInsetTop(),insets.getSystemWindowInsetRight(),insets.getSystemWindowInsetBottom());return insets; });
        LinearLayout heading=row(); heading.setPadding(dp(18),dp(12),dp(12),dp(4));
        title=text("Toulouse Ville",24,INK,true); heading.addView(title,new LinearLayout.LayoutParams(0,-2,1)); heading.addView(button("Réglages",this::settings)); root.addView(heading);
        LinearLayout tabs=row(); tabs.setPadding(dp(16),dp(6),dp(16),dp(8));
        cityTab=button("Explorer la ville",()->switchMode("city")); transitTab=button("Tisséo",()->switchMode("transport")); tabs.addView(cityTab,new LinearLayout.LayoutParams(0,dp(44),1)); LinearLayout.LayoutParams tlp=new LinearLayout.LayoutParams(0,dp(44),1);tlp.setMargins(dp(8),0,0,0);tabs.addView(transitTab,tlp);root.addView(tabs);
        search=new EditText(this);search.setSingleLine(true); search.setTextSize(14);search.setTextColor(INK);search.setPadding(dp(14),dp(8),dp(14),dp(8));search.setBackground(rounded(Color.WHITE,Color.rgb(222,222,211)));search.setHint("Un lieu, une sortie, une adresse…"); LinearLayout.LayoutParams slp=new LinearLayout.LayoutParams(-1,dp(46));slp.setMargins(dp(16),0,dp(16),dp(8));root.addView(search,slp);
        search.addTextChangedListener(new TextWatcher(){ public void beforeTextChanged(CharSequence s,int a,int c,int f){} public void onTextChanged(CharSequence s,int a,int b,int c){ ui.removeCallbacks(searchTask);ui.postDelayed(searchTask,200); } public void afterTextChanged(Editable e){} });
        search.setOnEditorActionListener((t,action,event)->{ ((InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(search.getWindowToken(),0); if(mode.equals("transport")&&!search.getText().toString().trim().isEmpty())searchStops();else render();return true; });
        HorizontalScrollView hs=new HorizontalScrollView(this);hs.setHorizontalScrollBarEnabled(false); chips=row();chips.setPadding(dp(16),0,dp(16),dp(8));hs.addView(chips);root.addView(hs);
        FrameLayout mapFrame=new FrameLayout(this);mapView=new MapView(this);mapView.onCreate(state);mapFrame.addView(mapView,new FrameLayout.LayoutParams(-1,-1));root.addView(mapFrame,new LinearLayout.LayoutParams(-1,0,1));
        LinearLayout controls=column();controls.setPadding(0,0,dp(12),0);controls.addView(button("Ma position",this::locate));controls.addView(button("Recentrer",()->{if(map!=null)map.animateCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(43.6047,1.4442),13));})); FrameLayout.LayoutParams clp=new FrameLayout.LayoutParams(-2,-2,Gravity.TOP|Gravity.END);clp.topMargin=dp(12);mapFrame.addView(controls,clp);
        panel=column();panel.setPadding(dp(16),dp(10),dp(16),0);panel.setBackground(rounded(PAPER,Color.rgb(226,222,212)));root.addView(panel,new LinearLayout.LayoutParams(-1,dp(292)));
        today=text("Aujourd’hui à Toulouse · chargement…",12,ACCENT,false);today.setPadding(0,0,0,dp(8));today.setOnClickListener(v->todayDialog());panel.addView(today);
        listTitle=text("À explorer",17,INK,true);panel.addView(listTitle); status=text("Chargement des sources…",11,MUTED,false);status.setPadding(0,dp(4),0,dp(5));panel.addView(status);
        ScrollView scroll=new ScrollView(this);results=column();scroll.addView(results);panel.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        mapView.getMapAsync(m->{ map=m;map.getUiSettings().setCompassEnabled(true);map.getUiSettings().setLogoEnabled(false);map.getUiSettings().setAttributionEnabled(true);map.setStyle(new Style.Builder().fromJson(asset("map.json")),s->{style=s;render();});map.moveCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(43.6047,1.4442),13.5));
            map.addOnMapClickListener(point->{List<Feature> fs=map.queryRenderedFeatures(map.getProjection().toScreenLocation(point),"place-point","vehicle-point","place-cluster");if(fs.isEmpty())return false;Feature f=fs.get(0);if(f.hasProperty("point_count")){map.animateCamera(CameraUpdateFactory.newLatLngZoom(point,map.getCameraPosition().zoom+2));return true;}String id=f.getStringProperty("id");JSONObject p=visibleById.get(id);if(p!=null){if(f.hasProperty("vehicle"))vehicleDetail(p);else placeDetail(p);}return true;});
            map.addOnCameraIdleListener(this::renderList);
        }); updateChips();
    }
    private String asset(String name) { try(InputStream s=getAssets().open(name)){ return readStream(s); }catch(Exception e){throw new IllegalStateException(e);} }
    private static String readStream(InputStream s)throws IOException{ByteArrayOutputStream out=new ByteArrayOutputStream();byte[] b=new byte[8192];int n;while((n=s.read(b))!=-1)out.write(b,0,n);return out.toString(StandardCharsets.UTF_8.name());}
    private void switchMode(String value) { mode=value;showStops=false;favoritesOnly=false;search.setText("");prefs.edit().putString("mode",mode).apply(); if(mode.equals("transport"))loadVehicles();updateChips();render(); }
    private void updateChips() {
        chips.removeAllViews();boolean city=mode.equals("city"); title.setText(city?"Toulouse Ville":"Tisséo Live");search.setHint(city?"Un lieu, une sortie, une adresse…":"Ligne, destination ou arrêt…");
        cityTab.setTextColor(city?ACCENT:MUTED);transitTab.setTextColor(city?MUTED:ACCENT);
        if(city){addChip("Catégories",this::categoryDialog);addChip("Filtres",this::filterDialog);addChip("Autour de moi",this::aroundDialog);addChip(favoritesOnly?"★ Favoris":"☆ Favoris",this::toggleFavorites);addChip("Ce soir",()->intent("tonight"));addChip("Une balade",()->intent("stroll"));addChip("En famille",()->intent("family"));}
        else {addChip("Arrêts proches",this::loadNearby);addChip("Itinéraire",()->journeyDialog(null));addChip("Info trafic",this::alertDialog);addChip("Véhicules",()->{showStops=false;loadVehicles();render();});}
        addChip("Actualiser",()->{lastError="";if(city){for(String id:selected)loadPlaces(id);loadToday();}else loadVehicles();});
    }
    private void resetFilters(){openOnly=false;freeOnly=false;accessibleOnly=false;vegetarianOnly=false;eventTag="";period="upcoming";}
    private void toggleFavorites(){favoritesOnly=!favoritesOnly;resetFilters();if(favoritesOnly){Set<String> ids=new HashSet<>();for(JSONObject p:favorites.values())ids.add(p.optString("category"));for(String id:ids)if(catalog.containsKey(id))loadPlaces(id);}render();updateChips();}
    private JSONObject currentFavorite(JSONObject saved){
        JSONObject d=datasets.get(saved.optString("category"));JSONArray a=d==null?null:d.optJSONArray("places");if(a!=null)for(int i=0;i<a.length();i++){JSONObject p=a.optJSONObject(i);if(p!=null&&p.optString("id").equals(saved.optString("id")))return p;}
        try{JSONObject p=new JSONObject(saved.toString());p.put("opening_state","unknown");if(p.optString("category").equals("bikes")){p.put("bikes",JSONObject.NULL);p.put("docks",JSONObject.NULL);}return p;}catch(Exception ignored){return saved;}
    }
    private void intent(String intent) {
        resetFilters();favoritesOnly=false;selected.clear();
        selected.addAll(Arrays.asList(intent.equals("tonight")?new String[]{"events","food","culture","bikes"}:intent.equals("stroll")?new String[]{"parks","visits","water","toilets","bikes"}:new String[]{"events","parks","libraries","water","toilets"}));
        period=intent.equals("tonight")?"tonight":"week";eventTag=intent.equals("family")?"family":"";showTransport=true;loadVehicles();rememberCategories();for(String id:selected)if(!datasets.containsKey(id))loadPlaces(id);render();
    }
    private void rememberCategories(){prefs.edit().putStringSet("categories",new HashSet<>(selected)).apply();}
    private void categoryDialog(){
        String[] ids=catalog.keySet().toArray(new String[0]);String[] labels=new String[ids.length];boolean[] checked=new boolean[ids.length];for(int i=0;i<ids.length;i++){labels[i]=catalog.get(ids[i]).optString("label");checked[i]=selected.contains(ids[i]);}
        new AlertDialog.Builder(this).setTitle("Sur ma carte").setMultiChoiceItems(labels,checked,(d,i,on)->{if(on)selected.add(ids[i]);else selected.remove(ids[i]);}).setNeutralButton("Tout",(d,w)->{selected.addAll(catalog.keySet());applyCategories();}).setPositiveButton("Afficher",(d,w)->applyCategories()).setNegativeButton("Fermer",(d,w)->applyCategories()).show();
    }
    private void applyCategories(){favoritesOnly=false;rememberCategories();for(String id:selected)if(!datasets.containsKey(id))loadPlaces(id);render();}
    private void filterDialog(){
        LinearLayout box=column();box.setPadding(dp(20),dp(12),dp(20),dp(12));
        CheckBox open=check(box,"Ouvert maintenant (horaires connus)",openOnly),free=check(box,"Accès libre / gratuit publié",freeOnly),access=check(box,"Accès PMR déclaré",accessibleOnly),veggie=check(box,"Option végétarienne déclarée",vegetarianOnly),transit=check(box,"Véhicules Tisséo sur la carte",showTransport);
        Spinner dates=spinner(box,new String[]{"En cours & à venir","Aujourd’hui","Ce soir","Les 7 prochains jours"},Arrays.asList("upcoming","today","tonight","week").indexOf(period));
        Spinner tags=spinner(box,new String[]{"Toutes les sorties","Gratuites","En famille","Concerts","Expositions"},Arrays.asList("","free","family","concert","exhibition").indexOf(eventTag));
        box.addView(text("Les critères inconnus sont exclus du filtre. Vérifie les informations auprès du lieu.",12,MUTED,false));
        new AlertDialog.Builder(this).setTitle("Filtres pratiques & agenda").setView(box).setPositiveButton("Appliquer",(d,w)->{openOnly=open.isChecked();freeOnly=free.isChecked();accessibleOnly=access.isChecked();vegetarianOnly=veggie.isChecked();showTransport=transit.isChecked();period=new String[]{"upcoming","today","tonight","week"}[dates.getSelectedItemPosition()];eventTag=new String[]{"","free","family","concert","exhibition"}[tags.getSelectedItemPosition()];if(showTransport)loadVehicles();render();}).setNeutralButton("Effacer",(d,w)->{resetFilters();render();}).setNegativeButton("Annuler",null).show();
    }
    private CheckBox check(LinearLayout box,String label,boolean value){CheckBox c=new CheckBox(this);c.setText(label);c.setTextSize(13);c.setTextColor(INK);c.setChecked(value);box.addView(c);return c;}
    private Spinner spinner(LinearLayout box,String[] choices,int selected){Spinner s=new Spinner(this);s.setAdapter(new ArrayAdapter<>(this,android.R.layout.simple_spinner_dropdown_item,choices));s.setSelection(Math.max(0,selected));box.addView(s,new LinearLayout.LayoutParams(-1,dp(48)));return s;}
    private void aroundDialog(){String[] options={"5 minutes à pied","10 minutes à pied","15 minutes à pied","Retirer la zone"};new AlertDialog.Builder(this).setTitle("Autour de moi sur les chemins").setSingleChoiceItems(options,minutes/5-1,(d,index)->{d.dismiss();if(index==3){isoTicket++;isochrone=null;setGeo("zones",emptyCollection());render();return;}minutes=(index+1)*5;new AlertDialog.Builder(this).setTitle("Point de départ").setItems(new String[]{"Ma position","Centre de la carte"},(dialog,i)->{if(i==0)locate();else {LatLng c=map==null?new LatLng(43.6047,1.4442):map.getCameraPosition().target;originLat=c.getLatitude();originLon=c.getLongitude();calculateAround();}}).show();}).setNegativeButton("Fermer",null).show();}
    private void settings(){
        LinearLayout box=column();box.setPadding(dp(20),dp(12),dp(20),dp(12));box.addView(text("Toulouse Ville 1.0 · application Android native\nCarte : MapLibre Native / OpenStreetMap\nDonnées : Toulouse Métropole, OpenAgenda, Cyclocity, Open-Meteo\nAucune affiliation officielle à Tisséo.",13,MUTED,false));
        EditText field=new EditText(this);field.setText(api.base());field.setSingleLine(true);field.setTextSize(13);box.addView(field);box.addView(text("Serveur des données. Le test USB utilise 127.0.0.1:4127 ; le serveur public utilise HTTPS.",12,MUTED,false));
        new AlertDialog.Builder(this).setTitle("Connexion & sources").setView(box).setPositiveButton("Enregistrer",(d,w)->{try{api.setBase(field.getText().toString());prefs.edit().putString("api",api.base()).apply();generation++;isoTicket++;vehiclesLoading=false;datasets.clear();loading.clear();vehicles=new JSONArray();nearby=new JSONArray();isochrone=null;setGeo("zones",emptyCollection());lastError="";loadCatalog();loadToday();if(mode.equals("transport"))loadVehicles();}catch(Exception e){toast(e.getMessage());}}).setNeutralButton("Serveur public",(d,w)->{api.setBase(BuildConfig.API_URL);prefs.edit().putString("api",api.base()).apply();recreate();}).setNegativeButton("Fermer",null).show();
    }

    // Chargements hors du thread principal et sauvegardes explicites des lieux.
    private interface Loaded { void run(JSONObject j); }
    private void request(String path,Loaded success,java.util.function.Consumer<Exception> failure){int epoch=generation;io.execute(()->{try{JSONObject j=api.get(path);ui.post(()->{if(!isDestroyed()&&epoch==generation)success.run(j);});}catch(Exception e){ui.post(()->{if(!isDestroyed()&&epoch==generation)failure.accept(e);});}});}
    private void loadCatalog(){
        request("/api/city/catalog",j->{io.execute(()->{try(FileOutputStream f=openFileOutput("catalog.json",MODE_PRIVATE)){f.write(j.toString().getBytes(StandardCharsets.UTF_8));}catch(Exception ignored){}});acceptCatalog(j);},e->{lastError=e.getMessage();int epoch=generation;io.execute(()->{JSONObject saved=null;try(FileInputStream f=openFileInput("catalog.json")){saved=new JSONObject(readStream(f));}catch(Exception ignored){}JSONObject ready=saved;ui.post(()->{if(isDestroyed()||epoch!=generation)return;if(ready!=null)acceptCatalog(ready);else render();});});});
    }
    private void acceptCatalog(JSONObject j){catalog.clear();JSONArray a=j.optJSONArray("categories");if(a==null){lastError="Catalogue indisponible";render();return;}for(int i=0;i<a.length();i++){JSONObject c=a.optJSONObject(i);if(c!=null)catalog.put(c.optString("id"),c);}selected.retainAll(catalog.keySet());for(String id:selected)loadPlaces(id);for(String id:Arrays.asList("events","works"))if(!selected.contains(id))loadPlaces(id);if(mode.equals("transport"))loadVehicles();render();}
    private void loadPlaces(String id){
        if(!loading.add(id))return;render();int epoch=generation;
        io.execute(()->{JSONObject result=null;String error="";try{result=api.get("/api/city/places?category="+Api.q(id));if("ok".equals(result.optString("status")))try(FileOutputStream f=openFileOutput("city-"+id+".json",MODE_PRIVATE)){f.write(result.toString().getBytes(StandardCharsets.UTF_8));}}
            catch(Exception e){error=e.getMessage();try(FileInputStream f=openFileInput("city-"+id+".json")){result=new JSONObject(readStream(f));result.put("status","stale");result.put("message","Hors connexion · dernières données conservées");JSONArray ps=result.optJSONArray("places");if(ps!=null)for(int i=0;i<ps.length();i++){JSONObject p=ps.optJSONObject(i);if(p!=null){p.put("opening_state","unknown");if(id.equals("bikes")){p.put("bikes",JSONObject.NULL);p.put("docks",JSONObject.NULL);}}}}catch(Exception ignored){} }
            JSONObject ready=result;String message=error;ui.post(()->{if(isDestroyed()||epoch!=generation)return;loading.remove(id);if(ready!=null)datasets.put(id,ready);else lastError=message;render();});
        });
    }
    private boolean vehiclesLoading;
    private void loadVehicles(){if(vehiclesLoading)return;vehiclesLoading=true;request("/api/vehicles",j->{vehiclesLoading=false;vehicles=j.optJSONArray("vehicles");if(vehicles==null)vehicles=new JSONArray();lastError=j.optBoolean("stale")?"Flux Tisséo ancien · positions à vérifier":"";render();},e->{vehiclesLoading=false;lastError=e.getMessage();vehicles=new JSONArray();render();});}
    private void loadToday(){request("/api/city/weather",j->{weather=j;renderToday();},e->{weather=null;renderToday();});request("/api/alerts",j->{alerts=j.optJSONArray("alerts");if(alerts==null)alerts=new JSONArray();renderToday();},e->{alerts=null;renderToday();});}
    private String weatherLabel(int code){return code==0?"ciel dégagé":code<=3?"nuages & éclaircies":code<=48?"brouillard":code<71?"pluie possible":code<86?"précipitations":"orages possibles";}
    private String todayCount(String id){JSONObject d=datasets.get(id);JSONArray ps=d==null?null:d.optJSONArray("places");if(ps==null)return "…";if("unavailable".equals(d.optString("status")))return "?";int count=0;for(int i=0;i<ps.length();i++)if(eventToday(ps.optJSONObject(i),GeoRules.today()))count++;return Integer.toString(count);}
    private void renderToday(){today.setVisibility(mode.equals("city")?View.VISIBLE:View.GONE);today.setText((weather==null?"Météo indisponible":Math.round(weather.optDouble("temperature_2m"))+"° · "+weatherLabel(weather.optInt("weather_code")))+"  ·  "+todayCount("events")+" sorties aujourd’hui  ›");}
    private void todayDialog(){LinearLayout box=column();box.setPadding(dp(20),dp(12),dp(20),dp(12));if(weather!=null)box.addView(text(Math.round(weather.optDouble("temperature_2m"))+"° · "+weatherLabel(weather.optInt("weather_code"))+"\n"+weather.optString("min")+"° / "+weather.optString("max")+"° · pluie "+weather.optString("rain_probability")+" %\nPrévision Open-Meteo · "+formatDate(weather.optString("fetched_at")),15,INK,false));box.addView(button(todayCount("events")+" sorties aujourd’hui",()->{selected.clear();selected.add("events");resetFilters();period="today";favoritesOnly=false;render();if(detailDialog!=null)detailDialog.dismiss();}));box.addView(button(todayCount("works")+" chantiers en cours",()->{selected.clear();selected.add("works");render();if(detailDialog!=null)detailDialog.dismiss();}));box.addView(button(alerts==null?"Info trafic indisponible":alerts.length()+" infos Tisséo",this::alertDialog));showSheet("Aujourd’hui à Toulouse",box);}
    private void alertDialog(){LinearLayout box=column();if(alerts==null||alerts.length()==0)box.addView(text(alerts==null?"Info trafic indisponible. Actualise pour réessayer.":"Aucune alerte publiée dans le flux consulté.",14,MUTED,false));else for(int i=0;i<alerts.length();i++){JSONObject a=alerts.optJSONObject(i);if(a!=null){box.addView(text(a.optString("title",a.optString("header",a.optString("header_text","Info Tisséo"))),16,INK,true));box.addView(text(android.text.Html.fromHtml(a.optString("description",a.optString("description_text","")),android.text.Html.FROM_HTML_MODE_LEGACY).toString().trim(),13,MUTED,false));}}showSheet("Info trafic Tisséo",box);}
    private boolean eventToday(JSONObject p,String day){
        if(p==null)return false;JSONArray sessions=p.optJSONArray("sessions");if(sessions!=null&&sessions.length()>0){for(int i=0;i<sessions.length();i++){JSONObject s=sessions.optJSONObject(i);try{if(GeoRules.day(s.getString("begin")).compareTo(day)<=0&&GeoRules.day(s.getString("end")).compareTo(day)>=0)return true;}catch(Exception ignored){}}return false;}
        return p.optString("start_date","9999").compareTo(day)<=0&&p.optString("end_date","").compareTo(day)>=0;
    }
    private boolean allowed(JSONObject p){
        String category=p.optString("category"),day=GeoRules.today();if((category.equals("events")||category.equals("works"))&&p.optString("end_date","").compareTo(day)<0)return false;
        if(openOnly&&!p.optString("opening_state").equals("open"))return false;if(accessibleOnly&&!p.optString("wheelchair").equals("yes"))return false;if(vegetarianOnly&&!p.optBoolean("vegetarian"))return false;
        String tags=p.optJSONArray("tags")==null?"":p.optJSONArray("tags").toString();if(freeOnly&&!p.optBoolean("free_access")&&!tags.contains("\"free\""))return false;
        if(category.equals("events")){
            if(!eventTag.isEmpty()&&!tags.contains("\""+eventTag+"\""))return false;
            if(period.equals("today")&&!eventToday(p,day))return false;
            if(period.equals("week")){boolean inWeek=false;for(int i=0;i<7;i++)if(eventToday(p,LocalDate.now(GeoRules.PARIS).plusDays(i).toString()))inWeek=true;if(!inWeek)return false;}
            if(period.equals("tonight")){boolean evening=false;JSONArray sessions=p.optJSONArray("sessions");if(sessions!=null)for(int i=0;i<sessions.length();i++){JSONObject s=sessions.optJSONObject(i);try{ZonedDateTime begin=OffsetDateTime.parse(s.getString("begin")).atZoneSameInstant(GeoRules.PARIS),end=OffsetDateTime.parse(s.getString("end")).atZoneSameInstant(GeoRules.PARIS);if(begin.toLocalDate().toString().compareTo(day)<=0&&end.toLocalDate().toString().compareTo(day)>=0&&(end.toLocalDate().toString().compareTo(day)>0||end.getHour()>=18)&&end.toInstant().isAfter(Instant.now()))evening=true;}catch(Exception ignored){}}if(!evening)return false;}
        }
        if(isochrone!=null&&walkingBand(p)>minutes)return false;
        if(p.optString("name").isEmpty())return false;
        String q=search.getText().toString().trim().toLowerCase(Locale.FRENCH);
        return q.isEmpty()||(p.optString("name")+" "+p.optString("address")+" "+p.optString("subtitle")+" "+p.optString("description")).toLowerCase(Locale.FRENCH).contains(q);
    }
    private List<JSONObject> places(){List<JSONObject> ps=new ArrayList<>();if(favoritesOnly){for(JSONObject saved:favorites.values()){JSONObject p=currentFavorite(saved);if(allowed(p))ps.add(p);}}else for(String id:selected){JSONObject d=datasets.get(id);JSONArray a=d==null?null:d.optJSONArray("places");if(a!=null)for(int i=0;i<a.length();i++){JSONObject p=a.optJSONObject(i);if(p!=null&&allowed(p))ps.add(p);}}LatLng center=map==null?new LatLng(43.6047,1.4442):map.getCameraPosition().target;ps.sort(Comparator.comparingDouble(p->GeoRules.distance(center.getLatitude(),center.getLongitude(),p.optDouble("lat"),p.optDouble("lon"))));return ps;}
    private void render(){if(title==null)return;renderToday();renderMap();renderList();}
    private String label(String id){return catalog.containsKey(id)?catalog.get(id).optString("label",id):id;}
    private String color(String id){return catalog.containsKey(id)?catalog.get(id).optString("color","#b45b40"):"#b45b40";}
    private JSONObject emptyCollection(){JSONObject j=new JSONObject();try{j.put("type","FeatureCollection").put("features",new JSONArray());}catch(Exception ignored){}return j;}
    private JSONObject pointFeature(JSONObject p,boolean vehicle){JSONObject f=new JSONObject();try{JSONObject props=new JSONObject();props.put("id",p.optString("id"));props.put("color",vehicle?"#"+p.optString("color","253c3b"):color(p.optString("category")));if(vehicle){props.put("vehicle",true);props.put("line",p.optString("line"));}else props.put("group",catalog.containsKey(p.optString("category"))?catalog.get(p.optString("category")).optString("group"):"daily");f.put("type","Feature").put("geometry",new JSONObject().put("type","Point").put("coordinates",new JSONArray().put(p.optDouble("lon")).put(p.optDouble("lat")))).put("properties",props);}catch(Exception ignored){}return f;}
    private void setGeo(String id,JSONObject data){if(style==null)return;GeoJsonSource s=style.getSourceAs(id);if(s!=null)s.setGeoJson(data.toString());}
    private void renderMap(){
        if(style==null)return;visibleById.clear();JSONObject city=emptyCollection(),transit=emptyCollection();JSONArray cityFeatures=city.optJSONArray("features"),transitFeatures=transit.optJSONArray("features");
        if(mode.equals("city"))for(JSONObject p:places()){cityFeatures.put(pointFeature(p,false));visibleById.put(p.optString("id"),p);}
        if(mode.equals("transport")||showTransport)for(int i=0;i<vehicles.length();i++){JSONObject v=vehicles.optJSONObject(i);if(v==null)continue;String q=search.getText().toString().trim().toLowerCase(Locale.FRENCH);if(mode.equals("transport")&&!q.isEmpty()&&!(v.optString("line")+" "+v.optString("destination")).toLowerCase(Locale.FRENCH).contains(q))continue;transitFeatures.put(pointFeature(v,true));visibleById.put(v.optString("id"),v);}
        setGeo("places",city);setGeo("vehicles",transit);
    }
    private void renderList(){
        if(results==null)return;results.removeAllViews();String usb=api.base().contains("127.0.0.1")?"Test USB · ":"";
        if(mode.equals("transport")){
            listTitle.setText(showStops?"Arrêts & prochains passages":"Véhicules du réseau");status.setText(usb+(lastError.isEmpty()?"Positions estimées depuis les horaires · métro théorique":lastError));
            if(showStops){for(int i=0;i<nearby.length();i++){JSONObject s=nearby.optJSONObject(i);if(s==null)continue;results.addView(resultRow(s.optString("name"),departuresLabel(s.optJSONArray("departures")),"Arrêt",()->stopDetail(s)));}if(nearby.length()==0)results.addView(text("Aucun arrêt trouvé. Cherche un nom ou recentre la carte.",13,MUTED,false));}
            else{int count=0;for(int i=0;i<vehicles.length()&&count<pageSize;i++){JSONObject v=vehicles.optJSONObject(i);if(v==null)continue;String q=search.getText().toString().trim().toLowerCase(Locale.FRENCH);if(!q.isEmpty()&&!(v.optString("line")+" "+v.optString("destination")).toLowerCase(Locale.FRENCH).contains(q))continue;count++;results.addView(resultRow(v.optString("line")+" · "+v.optString("mode"),v.optString("destination"),v.optString("next_stop"),()->vehicleDetail(v)));}if(count==0)results.addView(text(vehiclesLoading?"Chargement Tisséo…":"Aucun véhicule à afficher.",13,MUTED,false));}
        }else{
            List<JSONObject> ps=places();listTitle.setText((favoritesOnly?"Mes favoris":"À explorer")+" · "+ps.size());
            boolean stale=datasets.values().stream().anyMatch(d->"stale".equals(d.optString("status")));status.setText(usb+(loading.size()>0?loading.size()+" sources en cours…":stale?"Hors connexion · dernières données conservées":!lastError.isEmpty()?lastError:isochrone!=null?"Zone de "+minutes+" min sur les chemins piétons":"S : sortir · B : bouger · Q : quotidien"));
            for(JSONObject p:ps.subList(0,Math.min(ps.size(),pageSize))){String secondary=p.optString("address","");if(secondary.isEmpty())secondary=p.optString("subtitle",label(p.optString("category")));if(p.optString("category").equals("bikes"))secondary=p.isNull("bikes")?"Disponibilité inconnue":p.optString("bikes")+" vélos · "+p.optString("docks","?")+" places · dernier relevé";if(p.optString("category").equals("events"))secondary=nextSession(p);
                results.addView(resultRow((favorites.containsKey(p.optString("id"))?"★ ":"")+p.optString("name"),secondary,isochrone==null?label(p.optString("category")):"≤ "+walkingBand(p)+" min à pied",()->placeDetail(p)));}
            if(ps.size()>pageSize)results.addView(button("Afficher davantage",()->{pageSize+=40;renderList();}));if(ps.isEmpty()&&loading.isEmpty())results.addView(text(favoritesOnly?"Enregistre un lieu depuis sa fiche pour le retrouver ici.":"Aucun lieu avec ces critères. Élargis les catégories ou les filtres.",13,MUTED,false));
        }
    }
    private View resultRow(String name,String subtitle,String hint,Runnable action){LinearLayout r=column();r.setPadding(dp(12),dp(10),dp(12),dp(10));r.setBackground(rounded(Color.WHITE,0));LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1,-2);lp.setMargins(0,dp(5),0,dp(3));r.setLayoutParams(lp);r.addView(text(name,14,INK,true));TextView sub=text(subtitle,12,MUTED,false);sub.setMaxLines(2);r.addView(sub);r.addView(text(hint,10,ACCENT,false));r.setClickable(true);r.setFocusable(true);r.setContentDescription(name+", "+subtitle+", "+hint);r.setOnClickListener(v->action.run());return r;}
    private String formatDate(String value){try{return OffsetDateTime.parse(value).atZoneSameInstant(GeoRules.PARIS).format(DateTimeFormatter.ofPattern("EEE d MMM, HH:mm",Locale.FRENCH));}catch(Exception e){return value;}}
    private String nextSession(JSONObject p){JSONArray sessions=p.optJSONArray("sessions");if(sessions!=null)for(int i=0;i<sessions.length();i++){JSONObject s=sessions.optJSONObject(i);try{if(OffsetDateTime.parse(s.optString("end")).toInstant().isAfter(Instant.now()))return formatDate(s.optString("begin"));}catch(Exception ignored){}}return p.optString("start_date")+" → "+p.optString("end_date");}
    private void showSheet(String name,LinearLayout box){if(detailDialog!=null)detailDialog.dismiss();detailDialog=new Dialog(this);LinearLayout wrapper=column();wrapper.setPadding(dp(20),dp(18),dp(20),dp(16));wrapper.setBackground(rounded(PAPER,0));LinearLayout head=row();head.addView(text(name,20,INK,true),new LinearLayout.LayoutParams(0,-2,1));head.addView(button("Fermer",()->detailDialog.dismiss()));wrapper.addView(head);ScrollView scroll=new ScrollView(this);box.setPadding(0,dp(12),0,dp(12));scroll.addView(box);wrapper.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));detailDialog.setContentView(wrapper);Window w=detailDialog.getWindow();if(w!=null){w.setBackgroundDrawableResource(android.R.color.transparent);w.setGravity(Gravity.BOTTOM);w.setLayout(-1,Math.round(getResources().getDisplayMetrics().heightPixels*.68f));}detailDialog.show();if(w!=null)w.setLayout(-1,Math.round(getResources().getDisplayMetrics().heightPixels*.68f));}
    private void placeDetail(JSONObject p){
        if(!detailPlaceId.equals(p.optString("id"))&&map!=null){detailOrigin=map.getCameraPosition().target;detailPlaceId=p.optString("id");}
        if(map!=null)map.animateCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(p.optDouble("lat"),p.optDouble("lon")),Math.max(16,map.getCameraPosition().zoom)));
        LinearLayout box=column();box.addView(text(p.optString("subtitle",label(p.optString("category"))),13,ACCENT,true));if(!p.optString("address").isEmpty())box.addView(text(p.optString("address"),14,MUTED,false));if(!p.optString("description").isEmpty())box.addView(text(p.optString("description"),14,INK,false));
        if(p.optString("category").equals("bikes")){box.addView(text(p.isNull("bikes")?"Disponibilités inconnues":p.optString("bikes")+" vélos · "+p.optString("docks","?")+" places",20,INK,true));long reported=p.optLong("reported_at",0);box.addView(text(reported==0?"Âge du relevé inconnu":"Relevé il y a "+Math.max(0,(System.currentTimeMillis()/1000-reported)/60)+" min · vérifier la disponibilité",12,MUTED,false));}
        JSONArray sessions=p.optJSONArray("sessions");if(sessions!=null){box.addView(text("Prochains créneaux",14,INK,true));int n=0;for(int i=0;i<sessions.length()&&n<5;i++){JSONObject s=sessions.optJSONObject(i);try{if(OffsetDateTime.parse(s.optString("end")).toInstant().isAfter(Instant.now())){box.addView(text(formatDate(s.optString("begin"))+" → "+formatDate(s.optString("end")),12,MUTED,false));n++;}}catch(Exception ignored){}}}else if(!p.optString("start_date").isEmpty())box.addView(text(p.optString("start_date")+" → "+p.optString("end_date"),12,MUTED,false));
        JSONArray ds=p.optJSONArray("details");if(ds!=null)for(int i=0;i<ds.length();i++){JSONObject d=ds.optJSONObject(i);if(d!=null)box.addView(text(d.optString("label")+" : "+d.optString("value"),13,MUTED,false));}
        Button fav=button(favorites.containsKey(p.optString("id"))?"★ Retirer des favoris":"☆ Enregistrer ce lieu",()->{String id=p.optString("id");if(favorites.containsKey(id))favorites.remove(id);else favorites.put(id,p);JSONObject saved=new JSONObject();for(Map.Entry<String,JSONObject> e:favorites.entrySet())try{saved.put(e.getKey(),e.getValue());}catch(Exception ignored){}prefs.edit().putString("favorites",saved.toString()).apply();placeDetail(p);render();});box.addView(fav);
        box.addView(button("Y aller à pied",()->walkTo(p)));box.addView(button("Y aller en transports",()->journeyDialog(p)));
        box.addView(button("Partager ce lieu",()->sharePlace(p)));
        if(!calendarSessions(p).isEmpty())box.addView(button("Ajouter au calendrier",()->chooseCalendarSession(p)));
        if(!p.isNull("url")&&!p.optString("url").isEmpty())box.addView(button("Site du lieu ↗",()->openUrl(p.optString("url"))));if(!p.optString("phone").isEmpty())box.addView(button("Appeler",()->startActivity(new Intent(Intent.ACTION_DIAL,Uri.parse("tel:"+p.optString("phone").replaceAll("[^+0-9]",""))))));
        String id=p.optString("category");JSONObject source=catalog.containsKey(id)?catalog.get(id).optJSONObject("source"):null;JSONObject dataset=datasets.get(id);String sourceUrl=p.optString("source_url",source==null?"":source.optString("url"));
        box.addView(text("Source : "+p.optString("source_label",source==null?id:source.optString("label"))+"\n"+p.optString("source_license",source==null?"":source.optString("license"))+(dataset==null?"":"\nConsultée : "+formatDate(dataset.optString("fetched_at")))+"\nLes horaires, tarifs et accès publiés restent à vérifier.",11,MUTED,false));if(!sourceUrl.isEmpty())box.addView(button("Consulter la source ↗",()->openUrl(sourceUrl)));showSheet(p.optString("name"),box);
    }
    private void sharePlace(JSONObject p){
        StringBuilder content=new StringBuilder(p.optString("name"));
        for(String key:Arrays.asList("address","city"))if(!p.optString(key).isEmpty())content.append("\n").append(p.optString(key));
        if(p.optString("category").equals("events"))content.append("\n").append(nextSession(p));
        content.append("\nhttps://www.openstreetmap.org/?mlat=").append(p.optDouble("lat")).append("&mlon=").append(p.optDouble("lon")).append("#map=17/").append(p.optDouble("lat")).append("/").append(p.optDouble("lon"));
        String source=p.optString("source_url");if(source.startsWith("https://")||source.startsWith("http://"))content.append("\n").append(source);
        Intent send=new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT,p.optString("name")).putExtra(Intent.EXTRA_TEXT,content.toString());
        try{startActivity(Intent.createChooser(send,"Partager ce lieu"));}catch(ActivityNotFoundException e){toast("Aucune application de partage disponible.");}
    }
    private List<JSONObject> calendarSessions(JSONObject p){
        List<JSONObject> available=new ArrayList<>();JSONArray sessions=p.optJSONArray("sessions");long now=System.currentTimeMillis();
        if(sessions!=null)for(int i=0;i<sessions.length();i++){JSONObject s=sessions.optJSONObject(i);if(s!=null&&EventTimeRules.upcomingWindow(s.optString("begin"),s.optString("end"),now)!=null)available.add(s);}
        available.sort(Comparator.comparingLong(s->EventTimeRules.upcomingWindow(s.optString("begin"),s.optString("end"),Long.MIN_VALUE)[0]));return available;
    }
    private void chooseCalendarSession(JSONObject p){
        List<JSONObject> available=calendarSessions(p);if(available.isEmpty()){toast("Aucun créneau publié à venir.");return;}
        String[] labels=new String[available.size()];for(int i=0;i<labels.length;i++)labels[i]=formatDate(available.get(i).optString("begin"))+" → "+formatDate(available.get(i).optString("end"));
        new AlertDialog.Builder(this).setTitle("Choisir le créneau publié").setItems(labels,(dialog,index)->{
            JSONObject session=available.get(index);long[] window=EventTimeRules.upcomingWindow(session.optString("begin"),session.optString("end"),System.currentTimeMillis());
            if(window==null){toast("Ce créneau est terminé.");return;}
            String source=p.optString("source_url");String description=p.optString("description")+"\n"+source+"\nCréneau publié dans Toulouse Ville. Vérifie auprès de l’organisateur.";
            Intent insert=new Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI)
                .putExtra(CalendarContract.Events.TITLE,p.optString("name"))
                .putExtra(CalendarContract.Events.EVENT_LOCATION,p.optString("address")+(p.optString("city").isEmpty()?"":" · "+p.optString("city")))
                .putExtra(CalendarContract.Events.DESCRIPTION,description)
                .putExtra(CalendarContract.Events.EVENT_TIMEZONE,GeoRules.PARIS.getId())
                .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME,window[0]).putExtra(CalendarContract.EXTRA_EVENT_END_TIME,window[1]);
            try{startActivity(insert);}catch(ActivityNotFoundException e){toast("Aucune application de calendrier disponible.");}
        }).setNegativeButton("Annuler",null).show();
    }
    private void openUrl(String value){Uri u=Uri.parse(value);if(!Arrays.asList("https","http").contains(u.getScheme()))return;try{startActivity(new Intent(Intent.ACTION_VIEW,u));}catch(ActivityNotFoundException e){toast("Aucun navigateur disponible.");}}
    private String departuresLabel(JSONArray a){if(a==null||a.length()==0)return "Aucun passage publié";List<String> labels=new ArrayList<>();for(int i=0;i<a.length()&&i<3;i++){JSONObject d=a.optJSONObject(i);labels.add(d.optString("line")+" · "+Math.max(0,(d.optLong("time")-System.currentTimeMillis()/1000+59)/60)+" min"+(d.optString("source").equals("gtfs")?" (horaire)":""));}return String.join("   ",labels);}
    private void loadNearby(){LatLng c=map==null?new LatLng(originLat,originLon):map.getCameraPosition().target;status.setText("Recherche des arrêts proches du centre de la carte…");request("/api/nearby?lat="+c.getLatitude()+"&lon="+c.getLongitude()+"&n=8",j->{nearby=j.optJSONArray("stops");if(nearby==null)nearby=new JSONArray();showStops=true;renderList();},e->{lastError=e.getMessage();renderList();});}
    private void searchStops(){request("/api/stops/search?q="+Api.q(search.getText().toString())+"&n=10",j->{nearby=j.optJSONArray("stops");if(nearby==null)nearby=new JSONArray();showStops=true;renderList();},e->toast(e.getMessage()));}
    private void stopDetail(JSONObject stop){request("/api/departures?stop_id="+Api.q(stop.optString("id")),j->{LinearLayout box=column();JSONArray a=j.optJSONArray("departures");if(a==null||a.length()==0)box.addView(text("Aucun passage publié.",14,MUTED,false));else for(int i=0;i<a.length();i++){JSONObject d=a.optJSONObject(i);box.addView(text(d.optString("line")+" → "+d.optString("destination"),16,INK,true));box.addView(text(Math.max(0,(d.optLong("time")-System.currentTimeMillis()/1000+59)/60)+" min · "+(d.optString("source").equals("gtfs")?"horaire théorique":"prévision du flux Tisséo"),13,MUTED,false));}box.addView(button("Itinéraire vers cet arrêt",()->journeyDialog(stop)));showSheet(stop.optString("name"),box);},e->toast(e.getMessage()));}
    private void vehicleDetail(JSONObject v){LinearLayout box=column();box.addView(text(v.optString("destination"),20,INK,true));box.addView(text("Position estimée depuis les horaires Tisséo.\nProchain arrêt : "+v.optString("next_stop")+"\n"+(v.optString("mode").equals("Métro")?"Métro : mouvement théorique.":"La position n’est pas une mesure GPS."),14,MUTED,false));JSONArray remaining=v.optJSONArray("remaining");if(remaining!=null)for(int i=0;i<remaining.length();i++){JSONObject s=remaining.optJSONObject(i);box.addView(text(s.optString("name")+" · "+Math.max(0,(s.optLong("time")-System.currentTimeMillis()/1000+59)/60)+" min",13,INK,false));}showSheet("Ligne "+v.optString("line"),box);}
    private void journeyDialog(JSONObject destination){LinearLayout box=column();box.setPadding(dp(20),dp(12),dp(20),dp(12));EditText from=new EditText(this),to=new EditText(this);from.setSingleLine();to.setSingleLine();from.setHint("Départ : arrêt, adresse…");to.setHint("Arrivée : arrêt, adresse…");if(haveLocation)from.setText(locationLat+","+locationLon);if(destination!=null)to.setText(destination.optDouble("lat")+","+destination.optDouble("lon"));box.addView(from);box.addView(to);new AlertDialog.Builder(this).setTitle("Itinéraire Tisséo").setView(box).setPositiveButton("Calculer",(d,w)->{if(from.getText().toString().trim().isEmpty()||to.getText().toString().trim().isEmpty()){toast("Choisis le départ et l’arrivée.");return;}toast("Calcul de l’itinéraire…");request("/api/journey?from="+Api.q(from.getText().toString())+"&to="+Api.q(to.getText().toString()),this::journeyResult,e->toast(e.getMessage()));}).setNegativeButton("Annuler",null).show();}
    private void journeyResult(JSONObject j){LinearLayout box=column();box.addView(text(Math.ceil(j.optDouble("duration_s")/60)+" min · "+j.optInt("transfers")+" correspondance(s)",20,INK,true));JSONArray legs=j.optJSONArray("legs");if(legs==null||legs.length()==0)box.addView(text("Aucun trajet trouvé.",14,MUTED,false));else for(int i=0;i<legs.length();i++){JSONObject l=legs.optJSONObject(i);box.addView(text(l.optString("type").equals("ride")?"Ligne "+l.optString("line")+" · "+l.optString("mode"):"À pied",16,ACCENT,true));box.addView(text(l.optString("from")+" → "+l.optString("to"),14,INK,false));box.addView(text(l.optBoolean("real")?"Prévision temps réel Tisséo":"Estimation horaire",12,MUTED,false));}showSheet("Ton itinéraire",box);}
    private void calculateAround(){int ticket=++isoTicket;toast("Calcul des chemins piétons…");isochrone=null;request("/api/city/isochrone?lat="+originLat+"&lon="+originLon,j->{if(ticket!=isoTicket)return;isochrone=j;JSONArray fs=j.optJSONArray("features"),chosen=new JSONArray();if(fs!=null)for(int i=0;i<fs.length();i++){JSONObject f=fs.optJSONObject(i);if(f.optJSONObject("properties").optInt("contour")==minutes)chosen.put(f);}JSONObject zone=emptyCollection();try{zone.put("features",chosen);}catch(Exception ignored){}setGeo("zones",zone);if(map!=null)map.animateCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(originLat,originLon),14.5));render();},e->toast(e.getMessage()));}
    private boolean ringContains(JSONArray ring,double lon,double lat){List<double[]> ps=new ArrayList<>();for(int i=0;i<ring.length();i++){JSONArray xy=ring.optJSONArray(i);if(xy!=null)ps.add(new double[]{xy.optDouble(0),xy.optDouble(1)});}return GeoRules.inRing(lon,lat,ps);}
    private boolean polygonContains(JSONArray poly,double lon,double lat){if(poly==null||poly.length()==0||!ringContains(poly.optJSONArray(0),lon,lat))return false;for(int i=1;i<poly.length();i++)if(ringContains(poly.optJSONArray(i),lon,lat))return false;return true;}
    private int walkingBand(JSONObject p){if(isochrone==null)return Integer.MAX_VALUE;JSONArray fs=isochrone.optJSONArray("features");int band=Integer.MAX_VALUE;for(int i=0;fs!=null&&i<fs.length();i++){JSONObject f=fs.optJSONObject(i),g=f.optJSONObject("geometry");JSONArray coords=g.optJSONArray("coordinates");boolean inside=false;if(g.optString("type").equals("Polygon"))inside=polygonContains(coords,p.optDouble("lon"),p.optDouble("lat"));else for(int k=0;k<coords.length();k++)if(polygonContains(coords.optJSONArray(k),p.optDouble("lon"),p.optDouble("lat")))inside=true;if(inside)band=Math.min(band,f.optJSONObject("properties").optInt("contour",999));}return band;}
    private void walkTo(JSONObject p){LatLng c=detailOrigin;double lat=isochrone!=null?originLat:haveLocation?locationLat:c.getLatitude(),lon=isochrone!=null?originLon:haveLocation?locationLon:c.getLongitude();String origin=isochrone!=null?"le point de la zone":haveLocation?"ma position":"le centre de la carte avant la sélection";toast("Calcul du parcours à pied…");request("/api/city/walk?from_lat="+lat+"&from_lon="+lon+"&to_lat="+p.optDouble("lat")+"&to_lon="+p.optDouble("lon"),j->{JSONObject fc=emptyCollection();try{fc.optJSONArray("features").put(new JSONObject().put("type","Feature").put("geometry",j.getJSONObject("geometry")).put("properties",new JSONObject()));}catch(Exception ignored){}setGeo("walking",fc);LinearLayout box=column();box.addView(text((int)Math.ceil(j.optDouble("duration_s")/60)+" min à pied · "+j.optInt("distance_m")+" m",20,INK,true));box.addView(text("Départ : "+origin+"\n"+j.optString("notice"),12,MUTED,false));JSONArray steps=j.optJSONArray("instructions");if(steps!=null)for(int i=0;i<steps.length();i++)box.addView(text((i+1)+". "+steps.optJSONObject(i).optString("text"),14,INK,false));showSheet("À pied vers "+p.optString("name"),box);},e->toast(e.getMessage()));}
    private void locate(){if(checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)!=PackageManager.PERMISSION_GRANTED&&checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)!=PackageManager.PERMISSION_GRANTED){requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION},81);return;}findLocation();}
    @Override public void onRequestPermissionsResult(int code,String[] permissions,int[] grants){super.onRequestPermissionsResult(code,permissions,grants);if(code==81){if(checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED||checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED)findLocation();else toast("Position non autorisée. Tu peux choisir le centre de la carte.");}}
    @SuppressWarnings("MissingPermission") private void findLocation(){
        locationManager=(LocationManager)getSystemService(LOCATION_SERVICE);stopLocation();toast("Recherche de ta position…");
        locationListener=new LocationListener(){public void onLocationChanged(Location l){stopLocation();useLocation(l);}public void onProviderEnabled(String p){}public void onProviderDisabled(String p){}public void onStatusChanged(String p,int s,Bundle b){}};
        try{boolean fine=checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED;String provider=fine&&locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER)?LocationManager.GPS_PROVIDER:LocationManager.NETWORK_PROVIDER;Location last=locationManager.getLastKnownLocation(provider);if(last!=null&&System.currentTimeMillis()-last.getTime()<5*60*1000){stopLocation();useLocation(last);return;}locationManager.requestLocationUpdates(provider,1000,0,locationListener);ui.postDelayed(()->{if(locationListener!=null){stopLocation();toast("Position indisponible. Utilise le centre de la carte.");}},15000);}catch(Exception e){stopLocation();toast("Active la localisation, ou choisis le centre de la carte.");}
    }
    private void stopLocation(){if(locationListener!=null&&locationManager!=null)try{locationManager.removeUpdates(locationListener);}catch(Exception ignored){}locationListener=null;}
    private void useLocation(Location l){originLat=l.getLatitude();originLon=l.getLongitude();locationLat=originLat;locationLon=originLon;haveLocation=true;JSONObject fc=emptyCollection(),p=new JSONObject();try{p.put("lat",originLat).put("lon",originLon);fc.optJSONArray("features").put(pointFeature(p,false));}catch(Exception ignored){}setGeo("position",fc);if(map!=null)map.animateCamera(CameraUpdateFactory.newLatLngZoom(new LatLng(originLat,originLon),15));if(mode.equals("city"))calculateAround();else loadNearby();}
    private void toast(String message){Toast.makeText(this,message==null?"Données indisponibles":message,Toast.LENGTH_LONG).show();}
    @Override public void onStart(){super.onStart();mapView.onStart();}
    @Override public void onResume(){super.onResume();resumed=true;mapView.onResume();ui.removeCallbacks(refreshTask);ui.postDelayed(refreshTask,15000);}
    @Override public void onPause(){resumed=false;ui.removeCallbacks(refreshTask);stopLocation();mapView.onPause();super.onPause();}
    @Override public void onStop(){mapView.onStop();super.onStop();}
    @Override public void onDestroy(){ui.removeCallbacksAndMessages(null);io.shutdownNow();if(detailDialog!=null)detailDialog.dismiss();mapView.onDestroy();super.onDestroy();}
    @Override public void onLowMemory(){super.onLowMemory();mapView.onLowMemory();}
    @Override public void onSaveInstanceState(Bundle out){super.onSaveInstanceState(out);mapView.onSaveInstanceState(out);}
}

package com.plagnito.toulouseville;

import android.app.AlertDialog;
import android.widget.*;
import android.content.SharedPreferences;
import org.json.*;
import java.time.ZoneId;

/** City selection and automatic detection are shared by every city data request. */
final class CityController {
    private final MainActivity host;
    private final SharedPreferences prefs;
    JSONObject profile;
    CityController(MainActivity host, SharedPreferences prefs) {
        this.host=host;this.prefs=prefs;
        try {profile=new JSONObject(prefs.getString("city_profile","{\"id\":\"fr:31555\",\"name\":\"Toulouse\",\"lat\":43.6047,\"lon\":1.4442,\"transport\":\"tisseo\",\"timezone\":\"Europe/Paris\"}"));}
        catch(Exception e){profile=new JSONObject();}
        timezone(profile.optString("timezone"));
    }
    String id(){return profile.optString("id","fr:31555");}
    String name(){return profile.optString("name","Toulouse");}
    boolean tisseo(){return "tisseo".equals(profile.optString("transport","tisseo"));}
    double lat(){return profile.optDouble("lat",43.6047);}
    double lon(){return profile.optDouble("lon",1.4442);}
    String query(){return "city="+Api.q(id());}
    String file(String key){return id().replaceAll("[^A-Za-z0-9]","_")+"-"+key+".json";}
    void timezone(String value){try{GeoRules.CITY_ZONE=ZoneId.of(value);}catch(Exception e){GeoRules.CITY_ZONE=ZoneId.systemDefault();}}
    void accept(JSONObject value,boolean move){if(value==null||!value.has("id"))return;boolean changed=!id().equals(value.optString("id"));profile=value;timezone(value.optString("timezone"));prefs.edit().putString("city_profile",value.toString()).apply();if(changed)host.resetCity(move);}
    void show(){
        LinearLayout box=host.column();EditText input=new EditText(host);input.setSingleLine();input.setHint("Paris, Lyon, Bordeaux, Berlin…");box.addView(input);
        TextView state=host.text("Ville actuelle : "+name(),13,MainActivity.MUTED,false);box.addView(state);LinearLayout choices=host.column();
        box.addView(Art.primary(host,R.drawable.ic_pin,"Rechercher une ville",()->{String q=input.getText().toString().trim();if(q.length()<2){state.setText("Saisis au moins deux lettres.");return;}state.setText("Recherche…");host.request("/api/cities/search?q="+Api.q(q),j->{choices.removeAllViews();JSONArray cities=j.optJSONArray("cities");state.setText(cities==null||cities.length()==0?"Aucune ville trouvée.":"Choisis ta ville");for(int i=0;cities!=null&&i<cities.length();i++){JSONObject p=cities.optJSONObject(i);if(p!=null)choices.addView(host.resultRow(R.drawable.ic_pin,MainActivity.ACCENT,p.optString("name"),p.optString("region",p.optString("country")),"",()->{prefs.edit().putBoolean("auto_city",false).apply();host.closeSheet();accept(p,true);}));}},e->state.setText(e.getMessage()));}));
        box.addView(Art.button(host,R.drawable.ic_target,"Détecter automatiquement ma ville",()->{prefs.edit().putBoolean("auto_city",true).apply();host.closeSheet();host.locate();}));box.addView(choices);
        box.addView(Art.note(host,R.drawable.ic_target,"La détection utilise la position que tu as autorisée."));
        box.addView(Art.note(host,R.drawable.ic_explore,"Les lieux sont référencés autour du centre de la ville ; la couverture dépend des données publiques."));
        box.addView(Art.note(host,R.drawable.ic_bus,"Tisséo en direct à Toulouse. Ailleurs : arrêts d’OpenStreetMap, et itinéraires dans ton application de cartes."));
        host.showSheet("Choisir ma ville",box);
    }
    void detect(double lat,double lon,Runnable after){host.request("/api/cities/detect?lat="+lat+"&lon="+lon,j->{accept(j.optJSONObject("profile"),false);after.run();},e->{host.toast(e.getMessage());after.run();});}
    boolean automatic(){return prefs.getBoolean("auto_city",true);}
}

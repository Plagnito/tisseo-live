package com.plagnito.toulouseville;
import android.app.*;
import android.appwidget.*;
import android.content.*;
import android.os.Bundle;
import org.json.JSONObject;
import java.util.*;

public final class WidgetConfigureActivity extends Activity {
    @Override public void onCreate(Bundle saved){super.onCreate(saved);setResult(RESULT_CANCELED);int id=getIntent().getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,AppWidgetManager.INVALID_APPWIDGET_ID);AppWidgetProviderInfo info=AppWidgetManager.getInstance(this).getAppWidgetInfo(id);if(info==null||!info.provider.equals(new ComponentName(this,DeparturesWidget.class))){finish();return;}
        PersonalStore store=new PersonalStore(this);List<JSONObject> stops=store.entries("stops");if(stops.isEmpty()){new AlertDialog.Builder(this).setTitle("Un arrêt pour ce widget").setMessage("Enregistre d’abord un arrêt dans Tisséo, puis ajoute le widget.").setPositiveButton("Ouvrir Tisséo",(d,w)->{startActivity(new Intent(this,MainActivity.class).putExtra("open_personal","transit"));finish();}).setNegativeButton("Annuler",(d,w)->finish()).show();return;}
        String[] labels=stops.stream().map(p->p.optString("name")).toArray(String[]::new);new AlertDialog.Builder(this).setTitle("Arrêt du widget").setItems(labels,(d,index)->{store.prefs.edit().putString("widget_"+id,stops.get(index).optString("id")).apply();DeparturesWidget.update(this,id);RefreshJobs.sync(this);RefreshJobs.now(this);setResult(RESULT_OK,new Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID,id));finish();}).setNegativeButton("Annuler",(d,w)->finish()).show();
    }
}

// =====================================================================
// VELOCITY ALIGNMENT — Full company store roster
// Maps store_id → { name, area, area_coach, region_coach }
// Three regions: Harold Lacoste, Preston Arnwine, Terrance Spillane
// =====================================================================

const ALIGNMENT = {
  // ── Harold Lacoste Region ──────────────────────────────────────────
  // Area 2011 — Darian Spikes
  "S038876":{"name":"Senoia","area":"Area 2011","area_coach":"Darian Spikes","region_coach":"Harold Lacoste"},
  "S039377":{"name":"Griffin","area":"Area 2011","area_coach":"Darian Spikes","region_coach":"Harold Lacoste"},
  "S039378":{"name":"Union City","area":"Area 2011","area_coach":"Darian Spikes","region_coach":"Harold Lacoste"},
  "S039379":{"name":"Jefferson St","area":"Area 2011","area_coach":"Darian Spikes","region_coach":"Harold Lacoste"},
  "S039384":{"name":"Newnan","area":"Area 2011","area_coach":"Darian Spikes","region_coach":"Harold Lacoste"},
  "S039454":{"name":"Zebulon","area":"Area 2011","area_coach":"Darian Spikes","region_coach":"Harold Lacoste"},
  "S039465":{"name":"Senoia Rd","area":"Area 2011","area_coach":"Darian Spikes","region_coach":"Harold Lacoste"},
  // Area 2016 — Ebony Simmons
  "S039383":{"name":"Stockbridge","area":"Area 2016","area_coach":"Ebony Simmons","region_coach":"Harold Lacoste"},
  "S039388":{"name":"Jonesboro Rd","area":"Area 2016","area_coach":"Ebony Simmons","region_coach":"Harold Lacoste"},
  "S039393":{"name":"Lovejoy","area":"Area 2016","area_coach":"Ebony Simmons","region_coach":"Harold Lacoste"},
  "S039429":{"name":"Ola","area":"Area 2016","area_coach":"Ebony Simmons","region_coach":"Harold Lacoste"},
  "S039461":{"name":"County Line","area":"Area 2016","area_coach":"Ebony Simmons","region_coach":"Harold Lacoste"},
  "S039513":{"name":"Jodeco","area":"Area 2016","area_coach":"Ebony Simmons","region_coach":"Harold Lacoste"},
  "S039521":{"name":"Kellytown","area":"Area 2016","area_coach":"Ebony Simmons","region_coach":"Harold Lacoste"},
  "S039522":{"name":"Ellenwood","area":"Area 2016","area_coach":"Ebony Simmons","region_coach":"Harold Lacoste"},
  // Area 2022 — Ja'Don McNeil
  "S039375":{"name":"Bells Ferry Rd","area":"Area 2022","area_coach":"Ja'Don McNeil","region_coach":"Harold Lacoste"},
  "S039376":{"name":"CrossRds","area":"Area 2022","area_coach":"Ja'Don McNeil","region_coach":"Harold Lacoste"},
  "S039382":{"name":"Glade Rd","area":"Area 2022","area_coach":"Ja'Don McNeil","region_coach":"Harold Lacoste"},
  "S039387":{"name":"Kennesaw","area":"Area 2022","area_coach":"Ja'Don McNeil","region_coach":"Harold Lacoste"},
  "S039392":{"name":"Towne Lake","area":"Area 2022","area_coach":"Ja'Don McNeil","region_coach":"Harold Lacoste"},
  "S039462":{"name":"Acworth/Emerson","area":"Area 2022","area_coach":"Ja'Don McNeil","region_coach":"Harold Lacoste"},
  // Area 2000 — Jorge Garcia
  "S039380":{"name":"Windy Hill","area":"Area 2000","area_coach":"Jorge Garcia","region_coach":"Harold Lacoste"},
  "S039386":{"name":"Powder Springs","area":"Area 2000","area_coach":"Jorge Garcia","region_coach":"Harold Lacoste"},
  "S039389":{"name":"Lithia Springs","area":"Area 2000","area_coach":"Jorge Garcia","region_coach":"Harold Lacoste"},
  "S039410":{"name":"Mableton","area":"Area 2000","area_coach":"Jorge Garcia","region_coach":"Harold Lacoste"},
  "S039451":{"name":"Bolton","area":"Area 2000","area_coach":"Jorge Garcia","region_coach":"Harold Lacoste"},
  "S039525":{"name":"Smyrna","area":"Area 2000","area_coach":"Jorge Garcia","region_coach":"Harold Lacoste"},
  "S039527":{"name":"Austell Rd","area":"Area 2000","area_coach":"Jorge Garcia","region_coach":"Harold Lacoste"},
  // Area 2015 — Marc Gannon
  "S039412":{"name":"Miracle Strip","area":"Area 2015","area_coach":"Marc Gannon","region_coach":"Harold Lacoste"},
  "S039413":{"name":"Navarre","area":"Area 2015","area_coach":"Marc Gannon","region_coach":"Harold Lacoste"},
  "S039414":{"name":"Gulf Breeze","area":"Area 2015","area_coach":"Marc Gannon","region_coach":"Harold Lacoste"},
  "S039415":{"name":"Miramar Beach","area":"Area 2015","area_coach":"Marc Gannon","region_coach":"Harold Lacoste"},
  "S039416":{"name":"Niceville","area":"Area 2015","area_coach":"Marc Gannon","region_coach":"Harold Lacoste"},
  "S039430":{"name":"Racetrack","area":"Area 2015","area_coach":"Marc Gannon","region_coach":"Harold Lacoste"},
  "S039529":{"name":"Crestview","area":"Area 2015","area_coach":"Marc Gannon","region_coach":"Harold Lacoste"},
  // Area 2034 — Michelle Meehan
  "S039381":{"name":"Fairburn Rd","area":"Area 2034","area_coach":"Michelle Meehan","region_coach":"Harold Lacoste"},
  "S039385":{"name":"Ridge Rd","area":"Area 2034","area_coach":"Michelle Meehan","region_coach":"Harold Lacoste"},
  "S039390":{"name":"East Paulding","area":"Area 2034","area_coach":"Michelle Meehan","region_coach":"Harold Lacoste"},
  "S039391":{"name":"Hwy 5","area":"Area 2034","area_coach":"Michelle Meehan","region_coach":"Harold Lacoste"},
  "S039526":{"name":"Dallas","area":"Area 2034","area_coach":"Michelle Meehan","region_coach":"Harold Lacoste"},

  // ── Preston Arnwine Region ─────────────────────────────────────────
  // Area 2041 — Open
  "S039417":{"name":"Collinsville","area":"Area 2041","area_coach":"ARNWINE-OPEN","region_coach":"Preston Arnwine"},
  "S039419":{"name":"Martinsville","area":"Area 2041","area_coach":"ARNWINE-OPEN","region_coach":"Preston Arnwine"},
  "S039421":{"name":"College Rd","area":"Area 2041","area_coach":"ARNWINE-OPEN","region_coach":"Preston Arnwine"},
  "S039424":{"name":"Gate City Blvd","area":"Area 2041","area_coach":"ARNWINE-OPEN","region_coach":"Preston Arnwine"},
  "S039427":{"name":"Pyramid Village","area":"Area 2041","area_coach":"ARNWINE-OPEN","region_coach":"Preston Arnwine"},
  "S039436":{"name":"Battleground","area":"Area 2041","area_coach":"ARNWINE-OPEN","region_coach":"Preston Arnwine"},
  "S039457":{"name":"E. Greensboro","area":"Area 2041","area_coach":"ARNWINE-OPEN","region_coach":"Preston Arnwine"},
  // Area 2017 — Emmanuel Boateng
  "S039418":{"name":"Riverside Dr","area":"Area 2017","area_coach":"Emmanuel Boateng","region_coach":"Preston Arnwine"},
  "S039422":{"name":"South Church","area":"Area 2017","area_coach":"Emmanuel Boateng","region_coach":"Preston Arnwine"},
  "S039423":{"name":"Graham","area":"Area 2017","area_coach":"Emmanuel Boateng","region_coach":"Preston Arnwine"},
  "S039432":{"name":"Mebane","area":"Area 2017","area_coach":"Emmanuel Boateng","region_coach":"Preston Arnwine"},
  "S039433":{"name":"Elton Way","area":"Area 2017","area_coach":"Emmanuel Boateng","region_coach":"Preston Arnwine"},
  "S039455":{"name":"Spring Garden","area":"Area 2017","area_coach":"Emmanuel Boateng","region_coach":"Preston Arnwine"},
  "S039456":{"name":"Whitsett","area":"Area 2017","area_coach":"Emmanuel Boateng","region_coach":"Preston Arnwine"},
  // Area 2004 — Erin Pizzo
  "S039420":{"name":"Harrisonburg","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  "S039425":{"name":"Elkton","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  "S039426":{"name":"Woodstock","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  "S039428":{"name":"Stuarts Draft","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  "S039431":{"name":"Staunton","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  "S039435":{"name":"Shoppers World","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  "S039450":{"name":"Orange","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  "S039453":{"name":"JMU/Market","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  "S039466":{"name":"Waynesboro","area":"Area 2004","area_coach":"Erin Pizzo","region_coach":"Preston Arnwine"},
  // Area 2009 — Royal Mitchell
  "S039400":{"name":"E Palmetto","area":"Area 2009","area_coach":"Royal Mitchell","region_coach":"Preston Arnwine"},
  "S039401":{"name":"Darlington","area":"Area 2009","area_coach":"Royal Mitchell","region_coach":"Preston Arnwine"},
  "S039402":{"name":"2nd Loop","area":"Area 2009","area_coach":"Royal Mitchell","region_coach":"Preston Arnwine"},
  "S039403":{"name":"Marion","area":"Area 2009","area_coach":"Royal Mitchell","region_coach":"Preston Arnwine"},
  // Area 2048 — Russell Kowalczyk
  "S039394":{"name":"Elberton","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},
  "S039395":{"name":"Abbeville","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},
  "S039396":{"name":"Hartwell","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},
  "S039398":{"name":"Royston","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},
  "S039399":{"name":"Lavonia","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},
  "S039404":{"name":"Greenwood Bypass","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},
  "S039405":{"name":"Simpsonville","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},
  "S039407":{"name":"Newberry","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},
  "S039408":{"name":"Seneca","area":"Area 2048","area_coach":"Russell Kowalczyk","region_coach":"Preston Arnwine"},

  // ── Terrance Spillane Region ───────────────────────────────────────
  // Area 2002 — Brenda Marta
  "S040090":{"name":"Main","area":"Area 2002","area_coach":"Brenda Marta","region_coach":"Terrance Spillane"},
  "S040091":{"name":"Silver City","area":"Area 2002","area_coach":"Brenda Marta","region_coach":"Terrance Spillane"},
  "S040093":{"name":"Missouri","area":"Area 2002","area_coach":"Brenda Marta","region_coach":"Terrance Spillane"},
  "S040102":{"name":"Deming","area":"Area 2002","area_coach":"Brenda Marta","region_coach":"Terrance Spillane"},
  // Area 2010 — Constance Miranda
  "S039180":{"name":"Zaragosa","area":"Area 2010","area_coach":"Constance Miranda","region_coach":"Terrance Spillane"},
  "S039182":{"name":"Vista","area":"Area 2010","area_coach":"Constance Miranda","region_coach":"Terrance Spillane"},
  "S039185":{"name":"Gateway","area":"Area 2010","area_coach":"Constance Miranda","region_coach":"Terrance Spillane"},
  "S039318":{"name":"Socorro","area":"Area 2010","area_coach":"Constance Miranda","region_coach":"Terrance Spillane"},
  "S039323":{"name":"Tierre Este","area":"Area 2010","area_coach":"Constance Miranda","region_coach":"Terrance Spillane"},
  "S041651":{"name":"Eastlake","area":"Area 2010","area_coach":"Constance Miranda","region_coach":"Terrance Spillane"},
  // Area 2033 — Eric Harstine
  "S040082":{"name":"Taylor Ranch","area":"Area 2033","area_coach":"Eric Harstine","region_coach":"Terrance Spillane"},
  "S040084":{"name":"7th/Lomas","area":"Area 2033","area_coach":"Eric Harstine","region_coach":"Terrance Spillane"},
  "S040101":{"name":"Washington/Zuni","area":"Area 2033","area_coach":"Eric Harstine","region_coach":"Terrance Spillane"},
  "S040107":{"name":"Coors/Barcelona","area":"Area 2033","area_coach":"Eric Harstine","region_coach":"Terrance Spillane"},
  "S040108":{"name":"Wyoming/Harper","area":"Area 2033","area_coach":"Eric Harstine","region_coach":"Terrance Spillane"},
  "S040111":{"name":"303 Coors","area":"Area 2033","area_coach":"Eric Harstine","region_coach":"Terrance Spillane"},
  // Area 2024 — Javier Martinez
  "S038729":{"name":"Kenworthy","area":"Area 2024","area_coach":"Javier Martinez","region_coach":"Terrance Spillane"},
  "S039174":{"name":"University","area":"Area 2024","area_coach":"Javier Martinez","region_coach":"Terrance Spillane"},
  "S039175":{"name":"Airway","area":"Area 2024","area_coach":"Javier Martinez","region_coach":"Terrance Spillane"},
  "S039178":{"name":"CrossRds EP","area":"Area 2024","area_coach":"Javier Martinez","region_coach":"Terrance Spillane"},
  "S039192":{"name":"Resler","area":"Area 2024","area_coach":"Javier Martinez","region_coach":"Terrance Spillane"},
  "S039324":{"name":"Outlet Mall","area":"Area 2024","area_coach":"Javier Martinez","region_coach":"Terrance Spillane"},
  "S039448":{"name":"Dyer","area":"Area 2024","area_coach":"Javier Martinez","region_coach":"Terrance Spillane"},
  // Area 2055 — Kevin Dunn
  "S040088":{"name":"Los Lunas","area":"Area 2055","area_coach":"Kevin Dunn","region_coach":"Terrance Spillane"},
  "S040096":{"name":"Belen","area":"Area 2055","area_coach":"Kevin Dunn","region_coach":"Terrance Spillane"},
  "S040099":{"name":"Candelaria","area":"Area 2055","area_coach":"Kevin Dunn","region_coach":"Terrance Spillane"},
  "S040100":{"name":"T or C","area":"Area 2055","area_coach":"Kevin Dunn","region_coach":"Terrance Spillane"},
  "S040110":{"name":"Bull Chicks","area":"Area 2055","area_coach":"Kevin Dunn","region_coach":"Terrance Spillane"},
  // Area 2039 — Max Losey
  "S039589":{"name":"Rio Rancho","area":"Area 2039","area_coach":"Max Losey","region_coach":"Terrance Spillane"},
  "S040094":{"name":"Villa Linda Mall","area":"Area 2039","area_coach":"Max Losey","region_coach":"Terrance Spillane"},
  "S040104":{"name":"Southern","area":"Area 2039","area_coach":"Max Losey","region_coach":"Terrance Spillane"},
  "S040105":{"name":"Las Vegas","area":"Area 2039","area_coach":"Max Losey","region_coach":"Terrance Spillane"},
  "S040106":{"name":"Espanola","area":"Area 2039","area_coach":"Max Losey","region_coach":"Terrance Spillane"},
  "S040109":{"name":"Unser & McMahon","area":"Area 2039","area_coach":"Max Losey","region_coach":"Terrance Spillane"},
  // Area 2043 — Oscar Gutierrez
  "S039173":{"name":"Yarbrough","area":"Area 2043","area_coach":"Oscar Gutierrez","region_coach":"Terrance Spillane"},
  "S039176":{"name":"Lovington","area":"Area 2043","area_coach":"Oscar Gutierrez","region_coach":"Terrance Spillane"},
  "S039177":{"name":"Hobbs","area":"Area 2043","area_coach":"Oscar Gutierrez","region_coach":"Terrance Spillane"},
  "S039179":{"name":"George Dieter","area":"Area 2043","area_coach":"Oscar Gutierrez","region_coach":"Terrance Spillane"},
  "S039188":{"name":"Carlsbad","area":"Area 2043","area_coach":"Oscar Gutierrez","region_coach":"Terrance Spillane"},
  "S039518":{"name":"Hobbs North","area":"Area 2043","area_coach":"Oscar Gutierrez","region_coach":"Terrance Spillane"},
  "S039530":{"name":"Montana","area":"Area 2043","area_coach":"Oscar Gutierrez","region_coach":"Terrance Spillane"},
  // Area 2008 — Tami Elliott-Baker
  "S040083":{"name":"20th St","area":"Area 2008","area_coach":"Tami Elliott-Baker","region_coach":"Terrance Spillane"},
  "S040085":{"name":"North Gallup","area":"Area 2008","area_coach":"Tami Elliott-Baker","region_coach":"Terrance Spillane"},
  "S040086":{"name":"Main Street","area":"Area 2008","area_coach":"Tami Elliott-Baker","region_coach":"Terrance Spillane"},
  "S040087":{"name":"East Gallup","area":"Area 2008","area_coach":"Tami Elliott-Baker","region_coach":"Terrance Spillane"},
  "S040092":{"name":"Aztec","area":"Area 2008","area_coach":"Tami Elliott-Baker","region_coach":"Terrance Spillane"},
  "S040112":{"name":"Durango","area":"Area 2008","area_coach":"Tami Elliott-Baker","region_coach":"Terrance Spillane"}
};

// Derived lookup structures built once at startup
const REGIONS    = [...new Set(Object.values(ALIGNMENT).map(s => s.region_coach))].sort();
const AREAS      = [...new Set(Object.values(ALIGNMENT).map(s => s.area))].sort();
const AREA_COACHES = [...new Set(Object.values(ALIGNMENT).map(s => s.area_coach))].sort();

// Area → region_coach lookup
const AREA_TO_REGION = {};
Object.values(ALIGNMENT).forEach(s => { AREA_TO_REGION[s.area] = s.region_coach; });

// Area coach → area lookup
const COACH_TO_AREA = {};
Object.values(ALIGNMENT).forEach(s => { COACH_TO_AREA[s.area_coach] = s.area; });

module.exports = { ALIGNMENT, REGIONS, AREAS, AREA_COACHES, AREA_TO_REGION, COACH_TO_AREA };

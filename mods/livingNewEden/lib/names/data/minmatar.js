"use strict";

const words = (text) => Object.freeze(text.trim().split(/\s+/));

const male = words(`
  Aksel Alf Anders Arne Arvid Asbjorn Audun Bard Bjarne Bjorn Brage Dag Einar Eirik Eivind Elling Endre Erland
  Erling Eskil Finn Frode Geir Gisle Gudmund Gunnar Haakon Hallvard Halvor Harald Hauk Helge Herleif Hjalmar Hrafn
  Ingvar Ivar Jarl Joar Jon Jostein Kare Ketil Kjell Knut Kolbjorn Lars Leif Magne Magnus Morten Odd Oddvar Olav
  Orm Ottar Ragnar Ragnvald Rolf Rune Sigurd Sindre Sjur Skule Snorre Solve Stein Steinar Sten Stig Sturla Svein
  Sverre Tor Tore Torgeir Torleif Torvald Trond Trygve Ulf Vebjorn Vegard Vidar Yngve Asmund Atle Birger Brynjar
  Egil Folke Gorm Grim Gudbrand Hagbart Halfdan Hemming Ingolf Kolbein Ormar Aslak Ailo Ante Heaika Iisko Isak
  Jovnna Niillas Nils Piera Sammol Sivert Brakkor Drekan Hjorvik Kaarvo Krovan Ragvik Skarn Tarvek Thrak Vedrik
  Yrvan Zorvak Haldrek Torvin Ulvak Varkis Grimvald Hrokar Jorund Starkad Thorkel Toke Ulfar Arnfinn Bersi Dreng
  Eyvind Flosi Grettir Hallbjorn Hord Hrolf Ingimar Kolskegg Ljot Ospak Runolf Skeggi Snaebjorn Thorgils Thorstein
  Thrain Vermund Asgaut Bolli Gest Glum Hoskuld Illugi Mord Olaf Sighvat Steinthor Torfi Ulfljot Vigfus Bodvar
  Brand Eystein Gizur Hafgrim Hrut Kalf Ozur Sorli Thorbrand Vestar Botolf Erlend Gaut Hroald Kolli Sveinung Throst
  Ulfhedin Aldvik Bekkar Drovan Eskarn Fjolvar Gravik Hekran Jarvok Keldar Mavrik Norvald Raskar Sigvar Tjarn
  Vargal Yrjar Hakvar Brennik Skaldur Torbrak Vekkar Arngrim Bjartmar Dagfinn Gunnstein Hallstein Ingjald Kolgrim
`);

const female = words(`
  Aase Agnete Alfhild Aslaug Astrid Audhild Bergljot Birgit Bodil Borghild Brynhild Dagny Dagrun Edda Eira Embla
  Freydis Frida Gerd Gudrun Gunhild Gunvor Halldis Hedda Helga Hilde Hjordis Inga Ingrid Ingunn Jorunn Kjersti
  Liv Magnhild Ragna Ragnhild Rakel Randi Runa Saga Sigrid Signe Sigrun Siri Solveig Sunniva Synnove Thora Thurid
  Tone Tora Torhild Tove Turid Unn Vigdis Ylva Yrsa Aud Asa Bera Bryndis Dis Eldrid Ellisiv Gro Groa Gyda Halla
  Herdis Hervor Hild Hlif Ingeborg Jofrid Ljotunn Oddny Ragnfrid Rannveig Saeunn Signy Steinunn Svanhild Thorbjorg
  Thordis Thorgerd Thorunn Valdis Valgerd Ailin Biret Elle Risten Marit Maret Ristin Brakka Kaiva Drekka Hjala
  Karva Ralda Skarra Torva Vedra Yrka Zarka Halva Jorra Kelda Ranka Sivka Ulka Velra Asvor Brekka Dalla Eirny
  Frosta Gerda Hekla Ilka Jodis Kolfinna Linna Myrra Nanna Orka Ragnvor Sefa Tyra Unna Vaka Asdis Bjorg Dagmar
  Elin Gudny Hallveig Hrefna Ingvild Jorid Katla Mjoll Osk Solrun Svala Thyri Ulfrun Vala Yngvild Alvhild Borgny
  Embjorg Finnvor Gisla Hallgerd Ingvor Jodny Kolbrun Lidveig Oddrun Ragnborg Sigvor Torgunn Ulvhild Vegdis
  Aslog Bothild Dagrid Eyrun Gjertrud Hallfrid Hjalmdis Jorhild Kristrun Ljufa Olrun Sigvalda Steinvor Torbjorg
  Ulvdis Valborg Arnbjorg Bergny Dagvor Eldbjorg Gunnvor Hildur Ingrun Jonna Kolla Lofta Mettra Nessa Oddveig
  Randvi Skjalda Torvi Ulla Varra Yrdis Hjalka Brenna Skarla Vekka Drenna Tjarna Kesra Morvka
`);

const last = words(`
  Aasen Berg Bakken Brekke Dahl Eide Fjeld Haugen Hagen Halvorsen Holm Hovland Lie Lund Moen Nygaard Strand Solberg
  Vik Aune Aas Bratt Dalen Engen Foss Grov Hauge Helland Hoel Holt Kvam Lien Lunde Myhre Nesse Rud Sand Skog Stene
  Storm Strom Tangen Tveit Vang Viken Aarvik Bjerke Borg Brun Dale Eng Fjell Gran Haug Heggen Holen Hus Kleven Lia
  Mo Nes Ree Rise Roe Sletten Stav Sund Tofte Ulvik Vold Aker Alm Birkeland Eggen Fosse Hamre Hovde Kvale Lervik
  Lyng Mork Nordby Ronning Sandvik Selvik Skaar Steen Sunde Torp Utne Vestby Hjelle Arnesson Bjornsson Einarsson
  Eiriksson Gunnarsson Haraldsson Ivarsson Knutsson Olafsson Ragnarsson Sigurdsson Steinsson Thorsson Ulfsson
  Halldorsson Hrafnsson Leifsson Magnusson Ormsson Sveinsson Torvaldsson Grimsson Kolsson Ketilsson Avrik Brakkan
  Drenn Hjorn Karvak Krenn Morvik Skeldar Tjalvo Ulvar Vheros Yrjan Zarkan Askar Bolvik Dravik Ekran Fennik Gorvik
  Halrek Jorvak Kelvik Lorvik Marvok Norak Orvik Pellek Rokvar Sarvik Torkan Urvik Varnak Aikio Balto Gaup Hetta
  Kitti Labba Magga Nango Oskal Somby Turi Utsi Aslaksen Buljo Mienna Skum Vars Bergum Bjorke Bryn Dybdahl Elvik
  Flaten Grande Gulbrandsen Hammer Hegge Hellum Hodne Hustad Jevne Kjos Krog Lillevik Lothe Melby Nordal
  Ostby Rimstad Ruud Saether Sjoberg Skjelbred Stokke Sveen Teigen Thune Vatne Volden Askvik Bergset Brattli Dovre
  Fjellheim Gjerde Hagland Holmen Hordnes Kvitberg Langeland Lunden Myrvold Nordheim Rasten Rognes Skaret
  Solheim Stordal Tjelle Ulsrud Vestre Agdal Bjorndal Eidsvik Fossum Gjesdal Hoff Kolstad Lindvik Moum Nyhus
  Romstad Skarstein Stenberg Tunheim Vassbotn Arneberg Eriksrud Grimstad Hellesund Kjellsen Orheim Ravnaas
  Skogheim Ulvestad Brakkvik Drekkar Hjolvar Karnstad Krovik Ragnstad Skarvik Tarvok Thrakken Vedrikson Yrvik
  Haldstad Grimvik Hrokstad Ulvborg Varkstad Kolvik Jorvik Drakvald Aslund Bremnes Egeland Furnes Hatlestad
  Iversen Jacobsen Kalvik Lauvsnes Mykland Naess Oppheim Ringstad Sandnes Tandberg Austad Brekken Dahlstrom Erstad
  Flatland Grovlund Haugland Kvalheim Lerstad Midtbo Nygard Overland Rossland Solbakken Tvedt Valstad Wiik Ystad
  Hjorvald Skeldstad Brekkar Vargstad Tjornvik Ormstad Svartvik Hrafnstad Kolbrekk
`);

module.exports = Object.freeze({ male, female, last });

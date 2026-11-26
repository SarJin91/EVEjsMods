"use strict";

const words = (text) => Object.freeze(text.trim().split(/\s+/));

const male = words(`
  Bogdan Bogomil Boleslav Borislav Bozhidar Branimir Bronislav Budimir Cedomir Chestimir Dalibor Danilo Desimir
  Dobromir Dobroslav Dragan Dragomir Drago Dusan Gorazd Gostimir Gradimir Hostivit Jaromir Jaroslav Kazimir
  Krasimir Kresimir Ljubomir Ljudevit Lubor Lutobor Mechislav Milan Milorad Miloslav Miodrag Mirko Miroslav
  Mstislav Nedeljko Negomir Ognjen Ostromir Pribislav Radim Radomir Radoslav Rastko Ratibor Rostislav Sobeslav
  Spytihnev Stanimir Stanislav Svetozar Svyatoslav Tihomir Tomislav Vadim Velimir Venceslav Vladimir Vladislav
  Vojislav Vratislav Vsevolod Vyacheslav Yaropolk Zbislav Zdeslav Zelimir Zvonimir Zoran Bogoljub Boris Bozo
  Branko Cvetko Darko Divoslav Domagoj Dobrogost Gojko Godemir Hranislav Ivo Jarognev Krum Lado Ljubo Mladen
  Momcilo Nenad Ninoslav Ozren Predrag Premysl Radek Radovan Ranko Slavko Sredoje Stojan Svetomir Trpimir Tvrtko
  Uros Vitomir Vlastimil Vukasin Zdravko Zelislav Zivko Budislav Dobran Drazan Hvalimir Kocel Lutomir Mojmir
  Nemanja Oleg Prvoslav Rogvolod Sudislav Tverdislav Vojtech Zhiznomir Bozhen Dobrovit Gromislav Ljutomir Ognjeslav
`);

const female = words(`
  Bogdana Bogumila Boleslava Bozhena Branislava Bronislava Dobrava Dobromila Dobroslava Dragana Dragica Dubravka
  Jadranka Jaroslava Kazimira Krasimira Ljuba Ljubica Ljudmila Lubomira Mila Milena Milica Milodara Miloslava
  Mira Miroslava Mlada Nada Nadezhda Nedeljka Radmila Radoslava Ratislava Snezhana Snjezana Stanislava Svetlana
  Svetla Velimira Vera Vesna Vladislava Vlasta Vojislava Zdenka Zlata Zvezdana Bogna Cvetana Danica Desislava
  Dobrinka Dragomira Duna Goranka Gorislava Jasna Jelena Kalina Ljiljana Ljubomira Milana Milka Mirna Nevena Olga
  Radka Radojka Ruzha Slava Slavica Smiljana Spasenija Stana Stojanka Svetoslava Tihana Tihomira Vedrana Velislava
  Vida Vitomira Vojka Zlatana Zvonimira Zivana Branka Dobrila Drahomira Gorana Hvalislava Jagoda Jarmila
  Kvetoslava Lubava Mileva Ognjana Plamena Premislava Radomila Rostislava Snezhka Svoboda Tomislava Venceslava
  Zbyslava Zelislava Zhivka Dobra Blaga Bratoljuba Cveta Dana Dara Jara Kosara Prvoslava Radunka Stoyana Veselina
  Vladimira Zorislava Budislava Gostislava Jarina Lutomira Mojmira Negoslava Ostromira
`);

const last = words(`
  Babic Bogdanov Bozic Brankovic Cernik Dobrev Dragovic Gorski Horvat Ivanov Jankovic Kovac Kolar Kral Krasnov
  Kuznik Lazic Lesnik Markovic Mlinar Novak Orlov Petrov Popov Radic Sokol Sokolov Stankovic Svobodov Tomic Vesely
  Vlasov Volkov Vukovic Zelenko Zoric Belov Bodrov Chernov Dubrov Gromov Hrast Jaksic Karas Kopecky Krajnc Lisac
  Medved Morozov Nemec Ostrov Pavlic Perovic Ribar Rozman Sedlak Smolnik Snegov Stolar Strnad Tesar Uhlir Vidmar
  Vrba Zajc Zupan Brodsky Cvetkovic Dvorak Grabar Hlavac Jelinek Kolarov Kosar Lebedev Lovrenc Malina Mazur Mesar
  Mrak Ozimek Pekar Plachy Rybar Sever Skala Slavik Stary Sumak Tkac Vodnik Vranic Zima Bartos Bezak Bilek Bobrov
  Cerny Divjak Doljak Drozd Glusak Golub Hrabar Jastreb Kamen Kobilar Kozlov Krivec Kunic Lipnik Lukac Orel Ostrc
  Pajk Poljak Rak Ravnik Repnik Sitar Skok Smrek Sova Stepan Toplak Vedrinec Vodopivec Vuk Zabek Zlatar Zupancic
  Belan Borovec Brezar Dolinar Gorjan Hribar Jamnik Kladnik Kosmac Lavric Mlakar Oblak Plesnik Potocnik Rebernik
  Skrabec Stibilj Trebar Volcic Zakrajsek Bogomolov Dobrynin Gorbunov Kalinin Lomov Mironov Nekrasov Pankratov
  Rodin Saveliev Tarasov Ushakov Voronin Kovalenko Moroz Shevchuk Bondar Hrytsenko Levchenko Melnyk Tkachuk
  Zhuravel Krasnodub Vodogor Ognjevid Gromoslav Dubrava Lesogor Snezhnik Zvezdin Mrakovic Hvalic Radogost
  Bogovic Cerovac Dobrich Gradnik Hrastnik Jarc Kamnik Lesar Mlinaric Ostrozan Pecnik Rodic Sokolic Studen
  Trnovec Vidovic Zgonc Bukovec Dolenc Gorenc Jerman Kranjc Lipovec Mavric Novosel Podgorac Rakovec Smolej
`);

module.exports = Object.freeze({ male, female, last });

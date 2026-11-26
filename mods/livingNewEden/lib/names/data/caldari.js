"use strict";

const words = (text) => Object.freeze(text.trim().split(/\s+/));

const male = words(`
  Aaro Aarne Aatos Aki Akio Akseli Arto Asahi Atsuo Daiki Eero Eemeli Eino Erkki Esa Haruki Haruto Heikki Hideo
  Hiroshi Hiroki Ilmari Ilkka Isamu Jaakko Jari Jarmo Joonas Jouko Juha Juhani Jukka Juuso Kaapo Kaito Kalevi
  Kalle Kari Kauko Keiji Kenji Kenta Kimmo Kosti Kouta Kunio Lassi Lauri Leevi Markku Masaru Matias Mikko Minoru
  Mitsuo Nobu Noriaki Oiva Olli Onni Osamu Otso Paavo Pekka Pentti Petri Raimo Rauno Reijo Riku Risto Ryota Sakari
  Santeri Satoru Seppo Shigeru Shota Simo Sulo Taavi Tadashi Taisto Takeshi Taneli Tapani Tapio Taro Teemu Teppo
  Tetsuo Toivo Tomi Toshio Tuomas Tuomo Unto Urho Usko Vaino Valtteri Veikko Veli Ville Yasuo Yoshio Yuuto Ahti
  Aimo Alpo Antero Armas Arvo Aulis Eetu Eljas Harri Hannu Ismo Jalmari Jere Joni Kaarlo Kauno Keijo Kustaa Lenni
  Martti Niilo Nuutti Ossi Paavali Reino Roope Sampo Sauli Severi Tarmo Tatu Tero Topi Tuure Uljas Vesa Viljo
  Voitto Hayato Hikaru Ichiro Iori Jiro Kazuo Kenzo Koji Makoto Masato Naoki Ryuji Takumi Tatsuya Yamato Yuji
  Daisuke Goro Hajime Isao Katsu Kiyoshi Mamoru Michio Noboru Rokuro Saburo Shinji Shiro Sota Susumu Tomoya Toru
  Yusuke Aikari Haarno Iskaru Joukai Kaimo Kenjari Mikaro Raikko Tavio Teruo Vesuro Yrjo Otsuro Akito Eiji Fumio
  Genji Hisao Ikuo Kazuki Kyosuke Masahiro Nobuo Ryosuke Seiji Shunsuke Tadao Takao Tomohiro Yasuhiro Yoichi
  Eskari Hakuro Jorumi Kaisen Mirato Naaro Okkari Rautsu Seikko Taiko Ukari Vaikuro Yaskari Arimo Ensio Heino
  Ilari Jussi Kyosti Lauha Mauno Olavi Pertti Rasmus Sisu Torsti Veeti Aarre Esko Hemmo Jaska Kaisu Lalli Mielo
`);

const female = words(`
  Aino Aili Aija Aiko Akane Akiko Anniina Anu Asuka Aya Ayaka Eeva Eija Elina Emi Emiko Enni Erja Haruka Hanako
  Hanna Heidi Helmi Hilkka Hina Hiromi Iida Iina Iiris Ilona Inkeri Irja Kaarina Kaisa Kana Kanako Kaori Katja
  Keiko Kiyoko Kirsi Kumiko Kyoko Laila Lempi Liisa Lotta Maiju Maija Maiko Mari Marjo Mayu Megumi Meri Midori
  Mieko Miia Mikako Minna Mio Misaki Miyu Nana Nanami Naoko Natsuki Niina Noora Oili Pia Pihla Pirjo Raili Reiko
  Riikka Rin Rina Ritva Saara Sachiko Sakura Sanna Satu Sayuri Seija Sena Shiori Siiri Sirpa Suvi Taina Taru
  Tiina Tomoko Tuija Tuuli Ulla Venla Vilja Yoko Yui Yuka Yumi Yuna Aada Aamu Alli Eila Elli Hely Helka Hertta
  Ilta Impi Jenna Kerttu Kielo Lahja Lumi Malla Marketta Mirja Oona Orvokki Pauliina Raija Ronja Saimi Selma
  Sointu Taimi Talvikki Tuula Unelma Vappu Veera Viivi Aimi Asami Chie Chiyo Eri Fumiko Harumi Hikari Hisako
  Kazue Kimiko Kotone Machiko Mai Masako Michiko Mitsuko Naomi Noriko Rei Rie Ryoko Sae Saki Sanae Setsuko Shizuka
  Sumiko Tae Takako Tamaki Wakana Yasuko Yoshiko Yuriko Ayame Kaiko Mieka Saili Tuiko Vesari Ainari Kaisuki Liiko
  Soila Saija Arja Marja Nelli Outi Tellervo Varpu Virpi Kaija Leena Sini Tarja Terhi Aikka Haruna Iseki Junko
  Kaede Kanae Mariko Mayumi Nozomi Rika Sawako Tomomi Yukari Yukiko Eveliina Hilla Jonna Kaarna Linnea Milla
  Nea Riina Seela Tyyne Ukka Aiveri Haaru Isoka Kaimi Mirei Nauri Oiko Raiska Sairi Tavira Vaiko Yorika Eskia
`);

const last = words(`
  Aalto Aaltonen Ahonen Aho Alanko Anttila Arola Halonen Hakala Hamalainen Harju Heikkila Heinonen Helin Hiltunen
  Hirvonen Holopainen Honkanen Huttunen Hyvonen Ikonen Ilves Jaakkola Jokela Jokinen Juntunen Jussila Kallio Karhu
  Karjalainen Kauppinen Keskinen Kettunen Kinnunen Kivela Kivi Koivisto Koivu Kokko Koponen Korhonen Korpela
  Koskela Koski Koskinen Kurki Kuusisto Laakso Lahti Laine Lampinen Lappalainen Laukkanen Lehtinen Lehto Lehtonen
  Leino Leppanen Lumme Luoma Maki Makinen Manninen Mattila Miettinen Mustonen Myllymaki Nevala Niemi Nieminen
  Nikula Nurmi Ojala Oksanen Paananen Pakarinen Parviainen Peltola Peltonen Pesonen Pietila Piirainen Pitkanen
  Pulkkinen Rantanen Rautio Repo Riihimaki Rinne Ruotsalainen Saarela Saari Saarinen Salminen Salo Savolainen
  Seppala Sirola Suominen Tanskanen Tikkanen Toivonen Tuominen Turunen Uusitalo Vainio Valtonen Vartiainen
  Vesterinen Viitanen Virtanen Vuorinen Ylonen Aaltio Hakkarainen Hautala Heino Hokkanen Hurme Jaatinen Jarvinen
  Kanerva Karppinen Kesti Kiiskinen Kolehmainen Kontio Kumpulainen Kuosmanen Laitinen Liimatainen Mononen
  Nousiainen Partanen Pelto Penttila Pyykko Rasanen Ronkainen Sillanpaa Sorsa Tahvanainen Tuomi Ukkonen Valkonen
  Vehvilainen Venalainen Ylinen Aaltola Ahola Ekola Hietala Hovi Huhta Huovinen Ihalainen Immonen Kaartinen
  Kemppainen Kivisto Lassila Marttila Nurminen Ollila Paavola Rajala Ranta Ruokonen Talvitie Tervo Uotila Vaara
  Valli Vehko Viljanen Ylitalo Hukkanen Kasari Lumikko Routa Halla Kaira Kuura Aoki Arai Asano Endo Fujita Fukuda
  Goto Hamada Hara Hasegawa Hayashi Hoshino Ikeda Imai Inoue Ishida Ishii Kato Kikuchi Kimura Kobayashi Kondo
  Kubo Maeda Matsuda Matsumoto Miura Miyazaki Mori Morita Murata Nakajima Nakamura Nakano Nishida Noguchi Ogawa
  Okada Okamoto Ono Saito Sakai Sakamoto Sasaki Sato Shimizu Sugiyama Takada Takagi Takahashi Takeda Tanaka
  Taniguchi Ueda Ueno Wada Watanabe Yamada Yamaguchi Yamamoto Yamashita Yoshida Yoshikawa Abe Akiyama Chiba Hirano
  Hirata Iwasaki Kaneko Kawaguchi Kojima Kudo Maruyama Mizuno Murakami Nagai Nomura Ota Sano Shibata Sugawara
  Takeuchi Tamura Uchida Yano Yokoyama Kaarnaso Haatonen Isokari Kiruneki Oshinen Tashinen Vaskuro Yarikka Okkonen
  Irisawa Kaitanen Otsuka Arakawa Fujimoto Hosokawa Ichikawa Kawamura Kurosawa Masuda Mochizuki Nishimura Onishi
  Sekine Takayama Tsuchiya Umeda Yasuda Akkanen Esukari Haikonen Itsuro Joukanen Kaisuro Maikonen Naarimo
  Oraskari Raitonen Sakaisen Taivanen Usokari Vaiskanen Yrjanen
`);

module.exports = Object.freeze({ male, female, last });

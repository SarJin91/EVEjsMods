"use strict";

const words = (text) => Object.freeze(text.trim().split(/\s+/));

const male = words(`
  Abiram Adiel Ahiram Amiel Ardavan Arash Asher Avram Azarel Bahram Barak Behzad Benyamin Boaz Cyrus Dariush
  Davood Eliav Elior Elkan Eran Ezra Farid Farhad Gideon Hadar Hamid Hiram Ilan Iraj Ishai Itamar Jahan Javad
  Kamran Kaveh Kian Kourosh Lior Mahan Malachi Matan Mehran Meir Micah Mordecai Nadav Navid Nima Omid Oren Parviz
  Payam Ramin Reuven Rostam Saman Shahin Shai Siavash Tamir Tiran Uziel Yaron Yoav Zarvan Zev Zohar Abner Adin
  Amos Ariav Azriel Bahman Barzin Benam Ehud Elad Eldad Elihu Enosh Ephraim Esfand Fereydun Golzar Hesam Hooman
  Ira Jamshid Jareth Kasra Keyvan Khosrow Mazdak Mehrdad Nadir Nahum Natan Nevo Oded Parsa Peyman Rafi Reza Sahand
  Sasan Shahram Shlomo Siamak Soheil Tahmasp Tobiah Yair Yehiel Yigal Yosef Zakai Zubin Ardeshir Behrouz Dara
  Erez Farzin Gil Habib Idan Jahangir Kamal Liron Manuchehr Mehrab Ofer Pouya Rouzbeh Shervin Tavor Yariv Zerah
  Abdiel Adoram Amitai Asaf Avner Barzel Dotan Elchanan Gamliel Hanan Imri Jethro Kenan Laban Machir Nachshon
  Ozni Raziel Seraiah Shemaiah Tzadok Yoram Zimri Zuriel Arsham Bijan Darab Faramarz Garshasp Iman Kayvan Nariman
  Pirouz Sohrab Turaj Yazdan Zal Behnam Ehsan Fardin Hormoz Jalal Aradin Hezrai Khemar Nabiel Raziran Sarith
  Tashiel Uzar Yaziel Zerakh Aramel Dekhar Ezrahel Hamarel Ishkor Joriel Kameth Marek Nahiel Ozrel Pazar Qadesh
  Rakhim Sameth Teshar Varam Yeshar Zakiel Arvand Babak Dariel Ebrahim Fariborz Goudarz Hirad Kiarash Mazyar
`);

const female = words(`
  Adina Ahuva Anahita Ariella Atara Avigail Aviva Azadeh Bahar Batya Bita Dalia Delara Dina Elana Eliana Esther
  Farah Farnaz Galit Golnar Hadas Hannah Hila Kiana Leila Mahsa Maya Mehri Mina Mitra Naama Nasrin Neda Nili Noa
  Ofra Orly Parisa Pari Rana Ravit Roxana Sahar Samira Sara Shadi Shira Shirin Simin Soraya Tal Tamar Tara Tirza
  Yael Yasmin Zahra Zara Ziva Adah Afsaneh Aliza Anat Arezou Avital Ayelet Azar Bahareh Daria Dorit Efrat Elnaz
  Fariba Golshan Hadassah Haleh Ilana Kimia Laleh Liat Mahin Mahnaz Malka Marjan Merav Michal Mojgan Nahid Nava
  Negar Niloufar Noga Orit Pegah Rivka Rozita Sarit Setareh Shahla Shoshana Sima Taraneh Tova Yaffa Yasaman Zehava
  Zohreh Adva Arielle Batsheva Chaya Devorah Elisheva Gila Keren Leah Lilach Margalit Moriah Nechama Oshrat Penina
  Reut Sigal Tehila Tziona Yocheved Zipporah Banu Darya Firouzeh Gelareh Homa Jaleh Katayoun Leyla Mandana
  Nazanin Paria Roya Sepideh Shabnam Shokoufeh Vida Yeganeh Ziba Atousa Behnaz Donya Elaheh Forough Ghazal Hasti
  Kosar Mahtab Nasim Parvin Roshan Saba Sanaz Shahrzad Yalda Zhaleh Hezra Aradiel Khemira Nabira Rahmi Sariel
  Tashira Uziella Yarina Amarel Dekhara Ezria Hamira Ishara Jorith Kameri Lazira Mareth Nahira Ozira Pazira
  Qadira Rakhel Teshira Varina Yeshara Zakira Ashira Behira Dalit Eden Hagar Inbal Liora Mazal Ronit Shulamit
  Talia Yardena Zemira Anousheh Delaram Gisoo Mahsima Nooshin Pantea Rokhsana Shiva Tahmineh Yasna Zarin
`);

const last = words(`
  Abadi Afshar Alavi Amini Ansari Asadi Azizi Bagheri Bahrami Daneshvar Ebadi Esfahani Farahani Farzaneh Ghaffari
  Habibi Hakimi Hashemi Hosseini Jafari Javadi Kamali Karimi Kazemi Khalili Mahmoudi Mansouri Mirza Moradi Najafi
  Nasiri Nouri Rahimi Rashidi Rezaei Sadeghi Safavi Salehi Shahidi Shirazi Soltani Tabrizi Tehrani Vaziri Yazdani
  Zamani Zand Ashkenazi Avraham Ben-Ami Ben-David Cohen Dagan Dayan Elazar Eshel Gal Golan Harel Hadad Katz Levi
  Mizrahi Navon Ofek Peretz Rosen Sasson Segal Shamir Sharon Shalev Tzur Yadin Amir Ben-Zvi Carmel Dror Eitan
  Gefen Gilad Halevi Kedem Lavi Nachum Pardo Raz Regev Shani Shaked Yaari Zur Agassi Alon Arad Biton Dahan
  Elkayam Gabay Hazan Kadosh Mor Ohana Peled Rubin Sabag Vaknin Avidan Bar Ben-Haim Damari Galili Hen
  Keidar Levin Maoz Neeman Paz Rotem Shoham Tamari Yehuda Ziv Bakhtiari Davari Eskandari Fallahi Golzari Jahani
  Kashani Larijani Madani Moshiri Naderi Omidi Pakravan Rostami Sabouri Tavakoli Vafaei Yousefi Zarrin Ardalan
  Behbahani Dehghan Farhadi Ghorbani Jalali Kermani Mehrabi Nikzad Rahbar Samadi Shams Taheri Zarei Arzadin
  Barzoth Dekarim Ezrath Hamarzad Ishkar Jorzad Kamazar Lazarim Maziran Nabozar Orzad Parsan Qarzad Razad Sarzir
  Tazmar Uzrad Vazir Yazrad Zerakhim Aldaran Bezrai Dashar Eskarim Fazrin Gorzad Hazrai Ilkar Jazmar Khazrin
  Mehzar Nurath Ozmar Pezrai Ramazar Shezrin Torzai Uzmar Vezrin Yazmar Zorai Abtahi Bozorgi Chamani Dashti
  Emami Firouzi Golestani Hamedani Ilkhani Jamali Kia Lotfi Mazandarani Nabavi Ostovar Rafiei Sepehri Talebi
  Vakili Yaghoubi Zanjani Akbari Bahari Darabi Esmaili Fakhri Gilani Hejazi Irani Kamrani Mostafavi Nazari
  Pourmand Ranjbar Saberi Tajik Zandi Amsalem Ben-Shimon Danino Ezra Gabbai Hoffi Kalif Malul Nissim Ovadia
  Rahamim Shalom Tubul Yifrach Zaken Assaf Barzilai Dekel Erel Gur Har-Zion Kfir Lahav Marom Nir Omer Porat Ronen
  Sagi Tzafrir Yanai Zamir Avishai Bachar Doron Eliyahu Gavish Hadari Ilani Kinneret Lapid Meron Naor Oz Pinto
  Rimon Sela Tirosh Uri Yogev Zadok Arzal Bezran Dekhrim Ezrahi Hamzad Isharon Khemzad Marzan Nabrel Ozaran
  Razhel Tashrin Varzad Yeshrim Zakhar
`);

module.exports = Object.freeze({ male, female, last });

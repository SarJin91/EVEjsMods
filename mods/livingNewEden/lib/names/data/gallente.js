"use strict";

const words = (text) => Object.freeze(text.trim().split(/\s+/));

const male = words(`
  Adrien Alain Albin Amaury Anatole Andre Anselme Antoine Aristide Armand Arnaud Arthur Auguste Aurele Baptiste
  Barnabe Basile Benoit Bertrand Blaise Bruno Cassien Cedric Celestin Clement Colin Cyprien Damien Denis Didier
  Dorian Edmond Elie Eloi Emeric Emile Enzo Etienne Evrard Fabien Felix Ferdinand Fernand Firmin Florent Francois
  Gabin Gael Gaspard Gauthier Gerard Gilles Gregoire Guillaume Gustave Hector Henri Herve Hilaire Hugo Hugues
  Isidore Jacques Jerome Joachim Joel Josselin Julien Lazare Leandre Leon Leonce Lionel Loic Lothaire Luc Lucien
  Marius Martin Mathis Maurice Maxence Maxime Michel Noel Octave Odilon Olivier Oscar Pascal Patrice Philippe
  Pierre Quentin Raoul Raphael Regis Remi Romain Sacha Sebastien Serge Simon Sylvain Theo Thibault Timothee
  Tristan Ulysse Urbain Valentin Victor Vincent Xavier Yann Yves Achille Adelin Aime Alphonse Ambroise Amedee
  Augustin Bertin Brice Calixte Charles Constant Corentin Cosme Donatien Eudes Eustache Evariste Fabrice Faustin
  Fulbert Gatien Germain Gervais Gilbert Godefroy Gratien Guy Hippolyte Honore Hubert Ignace Jean Justin Leopold
  Loris Ludovic Mael Malo Marcel Marceau Matthieu Melchior Modeste Narcisse Nestor Norbert Pacome Paulin Prosper
  Rodolphe Roland Rufin Severin Sixte Tancrede Thierry Tiburce Toussaint Valery Wilfried Yanis Zacharie Alban
  Aurelien Alessio Amadeo Arrigo Cesare Dario Emilio Enrico Fabio Flavio Giacomo Lorenzo Luca Marco Matteo Nico
  Orsino Paolo Renzo Silvio Tiziano Vasco Alonso Esteban Ignacio Mateo Rafael Tomas Anselin Bastiano Cyrille
`);

const female = words(`
  Adele Adeline Agathe Aimee Albane Alix Amandine Ambre Amelie Anais Angele Anouk Apolline Ariane Armelle Aude
  Aurelie Aurore Axelle Beatrice Berenice Blanche Brigitte Camille Capucine Carole Cecile Celestine Chantal
  Charlotte Chloe Clarisse Claire Clemence Colette Coralie Corinne Delphine Denise Diane Dominique Elise Eloise
  Emeline Emma Estelle Eugenie Eva Fanny Faustine Fleur Florence Gabrielle Genevieve Georgette Gisele Helene
  Heloise Honorine Ines Irene Isaure Jacqueline Jeanne Josephine Judith Juliette Justine Laetitia Laure Lea Leonie
  Lisette Louise Lucie Lydie Madeleine Maelys Manon Margaux Marguerite Marianne Marine Marion Mathilde Melanie
  Melodie Mireille Monique Morgane Muriel Nadege Nathalie Nicole Noemie Oceane Odette Odile Ophelie Pauline
  Perrine Philippine Rosalie Roxane Sabine Salome Sandrine Severine Solange Solene Sophie Suzanne Sylvie Tiphaine
  Valentine Veronique Victoire Violette Virginie Yolande Zoe Adelaide Agnes Albertine Alienor Ambroisine Anne
  Antoinette Augustine Bernadette Berthe Blandine Clotilde Dorothee Edith Eleonore Emilie Ernestine Felicie Flavie
  Gaelle Gwenaelle Hortense Jacinthe Joelle Josiane Leontine Lucienne Mahaut Marcelle Marielle Maryse Micheline
  Nina Ninon Olympe Paulette Pascale Prudence Raymonde Renee Romane Rosine Simone Sidonie Thais Therese Ursule
  Vivienne Yvette Zelie Alessia Bianca Chiara Fiora Giulia Livia Lucia Marina Rosa Serena Silvia Viola Elena
  Ombeline Aurane Cassandre Eulalie Gaetane Lorene Maylis Adrienne Alexandrine Annabelle Bettina Clementine
  Corisande Elodie Esther Fabienne Francine Gersende Hermine Isaline Jessamine Leocadie Lilou Mathurine Nolwenn
  Oriane Sylvaine Valerie Aglae Domitille
`);

const last = words(`
  Arnaud Aubert Aubry Barbier Baron Barre Benard Berger Bertin Besson Blanchard Bonnet Bouchet Boucher Boyer Brun
  Caron Carre Charpentier Chevalier Clement Collet Colin Cordier Cousin Dupuis Dufour Durand Faure Fleury Fontaine
  Fournier Garnier Gauthier Gerard Girard Giraud Guerin Guillot Hamon Hebert Jacob Joly Julien Lacroix Lambert
  Laurent Lebrun Leclerc Lefebvre Legrand Lemaire Leroy Lucas Mallet Marchand Martin Masson Mathieu Mercier Meunier
  Michaud Millet Moulin Noel Olivier Perrin Petit Picard Poirier Renaud Rey Riviere Robin Roger Rolland Roussel
  Roux Royer Simon Sauvage Texier Vasseur Vidal Vincent Allard Antoine Arnould Audibert Baudin Beaumont Belanger
  Bellamy Bertrand Blondel Bonneau Bourdon Bourgeois Brunet Chauvin Clerc Colas Courtois Delorme Deschamps
  Desmarais Dubois Dumont Duchene Dupont Duret Ferrand Ferrier Fortin Gaillard Gautier Germain Gilbert Godard
  Gosselin Granger Hardy Huet Jourdan Lagrange Langlois Laval Lebon Lecomte Leduc Lemoine Lenoir Lesage Maillard
  Marchal Martel Maurin Menard Morel Navarre Pages Paquet Pelletier Perrot Pichon Prevost Raynaud Rousseau
  Sabatier Tessier Thibault Tissier Vallet Verdier Vernet Villard Voisin Aubin Barthe Beaulieu Bellerose Bisset
  Bouvier Briand Chapelle Charron Clavel Delage Delmas Dorval Duclos Duhamel Escoffier Favre Ferrant Fouquet
  Gallet Garreau Lafarge Lamotte Lavigne Leblanc Lefort Malet Marais Marceau Masse Monet Montel Peyrot Rambert
  Rochefort Sorel Thevenet Vachon Varenne Vauclair Belmont Chastain Fabre Lafont Rocher Bellini Benedetti Bianchi
  Conti Costa Gallo Greco Lombardi Mancini Marino Moretti Ricci Romano Rossi Russo Santoro Valenti Vitale Amato
  Barone Caruso Colombo Fabbri Fontana Gentile Leone Longo Martini Monti Orsini Parisi Pellegrini Rinaldi Sala
  Serra Testa Villa Achard Andrieu Babin Bazin Bernier Bouquet Brochard Carpentier Chartier Coste Daniel
  Delattre Devaux Drouet Ducret Etienne Ferry Fleuret Gaudin Gervais Guichard Hoarau Jacquet Josse Labbe Lagarde
  Leger Lemercier Lhermitte Loiseau Maret Mignot Mouton Ollivier Pasquier Pinel Poulain Quentin Regnier Renou
  Ribeiro Rigaud Rouxel Sanchez Seguin Tanguy Thomas Turpin Vannier Vigier Aumont Belcourt Corbin Darras Esnault
  Gravier Jolivet Lebreton Morin Rivet Saulnier Tardieu
`);

module.exports = Object.freeze({ male, female, last });

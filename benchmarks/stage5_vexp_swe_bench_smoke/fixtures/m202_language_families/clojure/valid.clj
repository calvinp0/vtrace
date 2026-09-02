;; Fixture — café 日本語 before declarations
(ns fixture.core
  (:require [clojure.string :as str]))

;; Add two numbers.
(defn add [a b]
  (+ a b))

(def limit 10)

(defmacro shout [text] `(str/upper-case ~text))

(defprotocol Shape
  (area [this]))

(defrecord Point [x y])

(defn- helper [x] (inc x))

--
-- PostgreSQL database dump
--

-- Dumped from database version 16.4 (Debian 16.4-1.pgdg110+2)
-- Dumped by pg_dump version 16.4 (Debian 16.4-1.pgdg110+2)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: location_reports; Type: TABLE DATA; Schema: public; Owner: gialai
--

COPY public.location_reports (id, location_id, kind, lng, lat, note, client_hash, status, created_at, reviewed_at) FROM stdin;
1	f3ea9782-b004-4976-8a00-d3b24cef6831	moved	107.99934983253553	14.034131184600241	\N	0d153a8176504c33ef93f19379ac0e7f	pending	2026-10-17 02:29:34.847737+00	\N
2	645ecf86-7c89-440b-afdf-e9b9e894ce61	moved	108.01021719320687	14.061807992865027	\N	0d153a8176504c33ef93f19379ac0e7f	pending	2026-10-17 02:29:59.454483+00	\N
\.


--
-- Data for Name: location_reviews; Type: TABLE DATA; Schema: public; Owner: gialai
--

COPY public.location_reviews (id, location_id, action, lng, lat, from_lng, from_lat, note, report_id, created_at) FROM stdin;
\.


--
-- Name: location_reports_id_seq; Type: SEQUENCE SET; Schema: public; Owner: gialai
--

SELECT pg_catalog.setval('public.location_reports_id_seq', 2, true);


--
-- Name: location_reviews_id_seq; Type: SEQUENCE SET; Schema: public; Owner: gialai
--

SELECT pg_catalog.setval('public.location_reviews_id_seq', 1, false);


--
-- PostgreSQL database dump complete
--


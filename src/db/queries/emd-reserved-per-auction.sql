-- EMD reserved per auction per bidder company
SELECT
    ISNULL (SUM(EmdBallance), 0) AS BlockedEMD
FROM
    tbl_Data_EMDReserved
WHERE
    BidderCompId = 1118
    AND EmdBallance > 0